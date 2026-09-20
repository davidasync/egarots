import {
  DEFAULT_CONTENT_TYPE,
  DEFAULT_TTL_SECONDS,
  MAX_CACHE_SECONDS,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_FILENAME_LENGTH,
  MAX_OBJECT_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  ID_PATTERN,
  type CreateCommand,
  type CreateResult,
  type FetchCommand,
  type FetchResult,
  type ObjectMeta,
  type ObjectView,
} from "./entity";
import {
  ErrEmptyBody,
  ErrInvalidContentType,
  ErrInvalidFilename,
  ErrInvalidTTL,
  ErrLengthRequired,
  ErrNotFound,
  ErrRateLimited,
  ErrTooLarge,
  ErrUnidentifiedClient,
} from "./errors";
import type { Clock, IdGenerator, ObjectRepository, RateLimiter } from "./ports";

export interface Service {
  create(cmd: CreateCommand): Promise<CreateResult>;
  fetch(cmd: FetchCommand): Promise<FetchResult>;
  head(cmd: FetchCommand): Promise<ObjectView>;
}

/**
 * Types a browser will render as a document, or execute, when it is allowed to.
 * These are never echoed back as the stored content type — they are served as
 * `application/octet-stream` instead.
 *
 * `Content-Disposition: attachment` already stops a *navigation* from rendering
 * anything, but it does not apply to subresource loads: without this rewrite,
 * `<script src>` and `<img src>` against this service still work and it becomes
 * someone's free CDN. `image/svg+xml` is HTML in a trench coat, XML executes
 * script through XSLT, and PDF embeds JavaScript.
 *
 * A denylist loses on its own — this one is the third layer, behind forced
 * attachment and nosniff, not the primary control.
 */
const DANGEROUS_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/pdf",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

/**
 * Types a browser may render in place without being able to run script, and so
 * the only ones `?disposition=inline` is honoured for. Positive by design:
 * enumerating the safe formats is bounded, enumerating the dangerous ones is not.
 */
const INLINE_SAFE = new Set([
  "text/plain",
  "application/json",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** RFC 9110 8.3 type/subtype, plus whatever parameters follow the first `;`. */
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\s*(;.*)?$/;
const DIGITS_ONLY = /^\d+$/;

export function newService(
  objects: ObjectRepository,
  limiter: RateLimiter,
  clock: Clock,
  ids: IdGenerator,
): Service {
  return {
    async create(cmd: CreateCommand): Promise<CreateResult> {
      // An unattributable write cannot be rate limited, and Cloudflare always
      // sets cf-connecting-ip in production. Refuse rather than fall back to a
      // shared bucket keyed on "".
      if (cmd.clientIp === "") {
        throw ErrUnidentifiedClient();
      }
      // First, so a flood costs nothing downstream.
      if (!(await limiter.allow(cmd.clientIp))) {
        throw ErrRateLimited();
      }

      // Everything from here to readBody() is decided from headers alone, so an
      // oversized or malformed upload is rejected without buffering a byte.
      const declared = parseDeclaredLength(cmd.declaredLength);
      const ttlSeconds = resolveTTL(cmd.ttlSeconds);
      const contentType = normalizeContentType(cmd.contentType);
      const filename = normalizeFilename(cmd.filename);

      if (declared > MAX_OBJECT_BYTES) {
        throw ErrTooLarge();
      }

      const bytes = await cmd.readBody();

      // A Content-Length is a claim, not a fact. `hono/body-limit` trusts a
      // present one without verifying it, so an understated value walks straight
      // past that middleware — this is the check that actually holds.
      if (bytes.byteLength === 0) {
        throw ErrEmptyBody();
      }
      if (bytes.byteLength > MAX_OBJECT_BYTES) {
        throw ErrTooLarge();
      }

      const createdAt = clock.now();
      const expireAt = new Date(createdAt.getTime() + ttlSeconds * 1000);

      // Uniqueness rests on entropy alone. Backblaze's S3-compatible API has no
      // conditional write, so there is no atomic create-if-absent to retry
      // against — a colliding id would silently overwrite. At 62^12 that is a
      // ~1.6e-10 risk across a million live objects, which is the deal this
      // store makes. A HEAD before the PUT would not fix it: it still races,
      // and it would spend a Class B transaction on every single write, which
      // is the one B2 allowance small enough to matter.
      const id = ids.next();
      await objects.put({ id, bytes, contentType, filename, createdAt, expireAt });

      return {
        id,
        url: `${cmd.scheme}://${cmd.host}/${id}`,
        contentType,
        size: bytes.byteLength,
        filename,
        // The caller gets the etag from the read path; on create it is not worth
        // a second round trip to B2 just to echo it back.
        etag: "",
        createdAt,
        expireAt,
      };
    },

    async fetch(cmd: FetchCommand): Promise<FetchResult> {
      // A malformed id cannot name a stored object, so report the miss without
      // spending a Class B read on it. /favicon.ico costs nothing.
      if (!ID_PATTERN.test(cmd.id)) {
        throw ErrNotFound();
      }

      const obj = await objects.get(cmd.id);
      if (obj === null) {
        throw ErrNotFound();
      }

      const now = clock.now();
      if (obj.expireAt.getTime() <= now.getTime()) {
        // Reclaim the space on the way past. Best effort: deleteExpired returns
        // void and is never awaited, so a torn-down isolate can drop it. The
        // lifecycle rule is what guarantees the bytes go; this only makes it
        // happen sooner, and a B2 delete is a free Class A transaction. The body was
        // never transferred, so an expired read costs no egress either.
        objects.deleteExpired(cmd.id);
        throw ErrNotFound();
      }

      return { ...view(obj, cmd.disposition, now), bytes: await obj.readBytes() };
    },

    async head(cmd: FetchCommand): Promise<ObjectView> {
      if (!ID_PATTERN.test(cmd.id)) {
        throw ErrNotFound();
      }

      const meta = await objects.head(cmd.id);
      if (meta === null) {
        throw ErrNotFound();
      }

      const now = clock.now();
      if (meta.expireAt.getTime() <= now.getTime()) {
        objects.deleteExpired(cmd.id);
        throw ErrNotFound();
      }

      // Same derivation as fetch, deliberately: a HEAD that advertised the
      // stored content type while GET rewrote it would be both a lie and a
      // small information leak about what was uploaded.
      return view(meta, cmd.disposition, now);
    },
  };
}

/**
 * The cap has to bite before the body is buffered, and Content-Length is the
 * only pre-body signal there is. RFC 9110 15.5.12 defines 411 for exactly this,
 * so a request that cannot be sized is refused rather than read hopefully.
 */
function parseDeclaredLength(raw: string): number {
  if (raw === "" || !DIGITS_ONLY.test(raw)) {
    throw ErrLengthRequired();
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw ErrLengthRequired();
  }
  if (length === 0) {
    throw ErrEmptyBody();
  }
  return length;
}

/**
 * Parsed strictly: `Number(" 7 ")` is 7 and `parseInt("7abc")` is 7, and neither
 * is a valid ttl. A digits-only test first means anything else is the caller's
 * mistake rather than a silent coercion.
 */
function resolveTTL(raw: string): number {
  if (raw === "") {
    return DEFAULT_TTL_SECONDS;
  }
  if (!DIGITS_ONLY.test(raw)) {
    throw ErrInvalidTTL();
  }

  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TTL_SECONDS || seconds > MAX_TTL_SECONDS) {
    throw ErrInvalidTTL();
  }
  return seconds;
}

/**
 * Validated for shape only, never rewritten: the stored type is echoed back as
 * sent, which is the point of an object store. The checks exist to stop a header
 * injection — a CR or LF here would split the response — and to bound the size
 * of what ends up in the store's metadata.
 */
function normalizeContentType(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return DEFAULT_CONTENT_TYPE;
  }
  if (trimmed.length > MAX_CONTENT_TYPE_LENGTH) {
    throw ErrInvalidContentType();
  }
  // Printable ASCII only, which excludes CR, LF and NUL by construction.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw ErrInvalidContentType();
    }
  }
  if (!MEDIA_TYPE_PATTERN.test(trimmed)) {
    throw ErrInvalidContentType();
  }
  return trimmed;
}

/**
 * Basename only. A filename is a hint for the download dialog, never a path, so
 * anything through the last separator is dropped rather than rejected — callers
 * pass `/home/me/notes.txt` by accident and mean `notes.txt`.
 */
function normalizeFilename(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }

  const base = trimmed.split(/[/\\]/).pop() ?? "";
  if (base === "" || base === "." || base === "..") {
    throw ErrInvalidFilename();
  }
  if (base.length > MAX_FILENAME_LENGTH) {
    throw ErrInvalidFilename();
  }
  // Control characters would corrupt the header; the quoting in the handler
  // deals with the rest.
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw ErrInvalidFilename();
    }
  }
  return base;
}

/** The single place GET and HEAD agree on what the response looks like. */
function view(meta: ObjectMeta, requestedDisposition: string, now: Date): ObjectView {
  return {
    ...meta,
    servedContentType: servedContentType(meta.contentType),
    disposition: resolveDisposition(requestedDisposition, meta.contentType),
    maxAgeSeconds: remainingCacheSeconds(meta.expireAt, now),
  };
}

/** The essence of a media type: `text/plain; charset=utf-8` -> `text/plain`. */
function essence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function servedContentType(stored: string): string {
  return DANGEROUS_TYPES.has(essence(stored)) ? DEFAULT_CONTENT_TYPE : stored;
}

/**
 * `?disposition=inline` is a preference, not an instruction: anything outside
 * INLINE_SAFE is silently overruled back to attachment. Policy, so it lives in
 * the core — the handler only formats the header it is told to.
 */
function resolveDisposition(requested: string, contentType: string): "attachment" | "inline" {
  if (requested !== "inline") {
    return "attachment";
  }
  return INLINE_SAFE.has(essence(contentType)) ? "inline" : "attachment";
}

/** Clamped so a cached copy can never outlive the object it copies. */
function remainingCacheSeconds(expireAt: Date, now: Date): number {
  const remaining = Math.floor((expireAt.getTime() - now.getTime()) / 1000);
  return Math.max(0, Math.min(remaining, MAX_CACHE_SECONDS));
}
