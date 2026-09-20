import type { Context } from "hono";

import type { FetchCommand, ObjectView } from "../../core/storage/entity";
import { StorageError, type ErrorKind } from "../../core/storage/errors";
import type { Service } from "../../core/storage/service";
import type { CreateObjectResponse, ErrorResponse, HealthResponse } from "./dto";

const STATUS_BY_KIND: Record<ErrorKind, 400 | 403 | 404 | 411 | 413 | 429 | 503> = {
  // RFC 9110 15.5.12: the request is refused for want of a declared length.
  length_required: 411,
  empty_body: 400,
  // RFC 9110 15.5.14: the payload is larger than the server will process.
  too_large: 413,
  invalid_content_type: 400,
  invalid_filename: 400,
  invalid_ttl: 400,
  // Expired and malformed ids land here too: a distinct status would confirm
  // that an id once existed, and ids are the only thing protecting the bytes.
  not_found: 404,
  rate_limited: 429,
  // The write cannot be attributed to anyone, so it cannot be limited.
  unidentified_client: 403,
  // Not the client's fault and retryable: only reachable if the id generator is
  // producing collisions, which at 62^12 means it is broken.
  id_unavailable: 503,
  storage_unavailable: 503,
};

/**
 * Sent on every response that carries stored bytes. Four independent layers,
 * because this service serves attacker-supplied content from a hostname we own
 * and uploads are anonymous.
 *
 * 1. nosniff — stops a text/plain upload being sniff-upgraded into HTML, and
 *    blocks service-worker registration. That last one is the real escalation:
 *    a JS file at /<id> would have a default SW scope of `/`, letting an
 *    attacker intercept every later request to this origin, reads included.
 * 2. CSP `default-src 'none'; sandbox` — if anything is ever rendered despite
 *    the disposition, it renders in an opaque origin with no scripts and no
 *    subresources.
 * 3. CORP cross-origin — required for the legitimate client to read these bytes
 *    from a page that has enabled COEP. `same-origin` would break it.
 * 4. no-referrer — a rendered object cannot leak its own id, and therefore its
 *    own contents, through the Referer header.
 *
 * None of these affect `fetch()`: Response.json() parses regardless of content
 * type, and fetch ignores Content-Disposition entirely.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Referrer-Policy": "no-referrer",
};

export interface Handler {
  health(c: Context): Response;
  create(c: Context, svc: Service): Promise<Response>;
  fetch(c: Context, svc: Service): Promise<Response>;
  head(c: Context, svc: Service): Promise<Response>;
}

export function newHandler(): Handler {
  return {
    health(c: Context): Response {
      // Deliberately does not touch B2: a liveness endpoint anyone can call
      // should not let them spend Class B transactions or the daily request cap.
      return c.json<HealthResponse>({ ok: true });
    },

    async create(c: Context, svc: Service): Promise<Response> {
      try {
        const result = await svc.create({
          declaredLength: c.req.header("content-length") ?? "",
          contentType: c.req.header("content-type") ?? "",
          filename: c.req.query("filename") ?? "",
          ttlSeconds: c.req.query("ttl") ?? "",
          // Deferred: the service rejects an oversized or malformed request from
          // its headers alone and never calls this, so nothing is buffered.
          // Leaving the body unread is safe — workerd cancels the stream when
          // the response is sent.
          readBody: () => c.req.arrayBuffer(),
          clientIp: clientIP(c),
          host: c.req.header("host") ?? new URL(c.req.url).host,
          scheme: requestScheme(c),
        });

        return c.json<CreateObjectResponse>(
          {
            id: result.id,
            url: result.url,
            size: result.size,
            contentType: result.contentType,
            ...(result.filename === undefined ? {} : { filename: result.filename }),
            createdAt: result.createdAt.toISOString(),
            expireAt: result.expireAt.toISOString(),
          },
          201,
          // RFC 9110 says a 201 should carry it. The id is in the body anyway,
          // because Location is not readable cross-origin unless exposed — the
          // exact fragility that made the dpaste client scrape two places.
          { Location: `/${result.id}` },
        );
      } catch (err) {
        return mapError(c, err);
      }
    },

    async fetch(c: Context, svc: Service): Promise<Response> {
      try {
        const r = await svc.fetch(fetchCommand(c));
        return c.body(r.bytes, 200, objectHeaders(r));
      } catch (err) {
        return mapError(c, err);
      }
    },

    async head(c: Context, svc: Service): Promise<Response> {
      try {
        // Same headers as the GET, from the same value — RFC 9110 9.3.2. The
        // body is omitted here and Hono drops it again on the way out; what
        // matters is that nothing upstream had to transfer it.
        const view = await svc.head(fetchCommand(c));
        return c.body(null, 200, objectHeaders(view));
      } catch (err) {
        return mapError(c, err);
      }
    },
  };
}

function fetchCommand(c: Context): FetchCommand {
  return {
    id: c.req.param("id") ?? "",
    disposition: c.req.query("disposition") ?? "",
  };
}

/** The single place a stored object turns into response headers. */
function objectHeaders(v: ObjectView): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    "Content-Type": v.servedContentType,
    "Content-Length": String(v.size),
    ETag: v.etag,
    "Cache-Control": `public, max-age=${v.maxAgeSeconds}, immutable`,
    "Content-Disposition": contentDisposition(v.disposition, v.filename),
    "X-Expires-At": v.expireAt.toISOString(),
  };
}

/**
 * RFC 6266. Two spellings on purpose: `filename=` is ASCII-only and understood
 * everywhere, `filename*=` carries the real UTF-8 name for anything modern. The
 * ASCII fallback has non-printables, quotes and backslashes replaced rather than
 * stripped, so a crafted name cannot close the quoted-string and inject a header.
 */
function contentDisposition(kind: "attachment" | "inline", filename?: string): string {
  if (filename === undefined) {
    return kind;
  }
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function mapError(c: Context, err: unknown): Response {
  if (err instanceof StorageError) {
    return error(c, STATUS_BY_KIND[err.kind], err.message);
  }
  console.error("unhandled error", err);
  return error(c, 500, "internal error");
}

function error(
  c: Context,
  status: 400 | 403 | 404 | 411 | 413 | 429 | 500 | 503,
  message: string,
): Response {
  return c.json<ErrorResponse>({ error: message }, status);
}

/**
 * cf-connecting-ip only. nikednep falls back to x-forwarded-for and then to "",
 * which is harmless for 8 KB URLs and not harmless here: the header is entirely
 * client-controlled, so the fallback is a one-line rate-limit bypass, and "" puts
 * every unidentified caller in one shared bucket. Cloudflare always sets
 * cf-connecting-ip in production, so treat its absence as "not in production"
 * and let the service refuse the write.
 */
function clientIP(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "";
}

function requestScheme(c: Context): string {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) {
    return proto;
  }
  return new URL(c.req.url).protocol === "http:" ? "http" : "https";
}
