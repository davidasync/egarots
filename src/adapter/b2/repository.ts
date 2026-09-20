import {
  DEFAULT_CONTENT_TYPE,
  type NewObject,
  type ObjectMeta,
  type StoredObject,
} from "../../core/storage/entity";
import { ErrStorageUnavailable } from "../../core/storage/errors";
import type { ObjectRepository } from "../../core/storage/ports";
import { signRequest } from "./sigv4";

/**
 * Application facts B2 has no field for, carried as S3 user metadata. These map
 * to `x-amz-meta-*` headers, so every value is an ASCII string — timestamps go
 * in as decimal epoch milliseconds and the filename is percent-encoded, because
 * a non-ASCII byte in a header would break the signature before it broke
 * anything else.
 */
const META_CREATED_AT = "x-amz-meta-created-at";
const META_EXPIRES_AT = "x-amz-meta-expires-at";
const META_FILENAME = "x-amz-meta-filename";

export interface B2Config {
  keyId: string;
  appKey: string;
  bucket: string;
  /** e.g. `us-west-004`. One region per B2 account. */
  region: string;
  /** Defaults to `https://s3.<region>.backblazeb2.com`. */
  endpoint?: string;
}

/**
 * `waitUntil` is not optional in practice. A promise left floating after the
 * response is returned is cancelled by the runtime, so without it the lazy
 * delete silently never runs — which is exactly what happened the first time
 * this was written. The default keeps the adapter constructible in a test.
 */
export function newRepository(
  cfg: B2Config,
  now: () => Date = () => new Date(),
  waitUntil: (p: Promise<unknown>) => void = () => {},
): ObjectRepository {
  const base = cfg.endpoint ?? `https://s3.${cfg.region}.backblazeb2.com`;
  const urlFor = (id: string) => new URL(`/${cfg.bucket}/${id}`, base);

  async function send(
    method: string,
    id: string,
    headers: Record<string, string> = {},
    body?: ArrayBuffer,
  ): Promise<Response> {
    const url = urlFor(id);
    const signed = await signRequest({
      method,
      url,
      headers,
      body,
      keyId: cfg.keyId,
      appKey: cfg.appKey,
      region: cfg.region,
      now: now(),
    });
    return fetch(url.toString(), { method, headers: signed, body });
  }

  return {
    async head(id: string): Promise<ObjectMeta | null> {
      const res = await send("HEAD", id);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw await storageFailure("head", res);
      }
      return decode(id, res.headers);
    },

    async get(id: string): Promise<StoredObject | null> {
      const res = await send("GET", id);
      if (res.status === 404) {
        // Nothing to drain: B2 sends a small XML error body, and leaving it is
        // what workerd expects for a response we discard.
        return null;
      }
      if (!res.ok) {
        throw await storageFailure("get", res);
      }

      const meta = decode(id, res.headers);
      if (meta === null) {
        // Unusable metadata is not an outage: report a miss so the caller 404s,
        // but log it, because it means something wrote a shape this version does
        // not understand — or wrote straight to the bucket, bypassing the Worker
        // and therefore every check it performs.
        console.error("discarding object with unreadable metadata", { id });
        await res.body?.cancel();
        return null;
      }

      // Not awaited. The Class B transaction is already spent, but the body is a
      // stream that only transfers when something pulls it, so an object the
      // service throws away for being expired costs no bandwidth and no time.
      return { ...meta, readBytes: () => res.arrayBuffer() };
    },

    async put(o: NewObject): Promise<void> {
      const headers: Record<string, string> = {
        "content-type": o.contentType,
        [META_CREATED_AT]: String(o.createdAt.getTime()),
        [META_EXPIRES_AT]: String(o.expireAt.getTime()),
      };
      if (o.filename !== undefined) {
        headers[META_FILENAME] = encodeURIComponent(o.filename);
      }

      const res = await send("PUT", o.id, headers, o.bytes);
      if (!res.ok) {
        throw await storageFailure("put", res);
      }
      await res.body?.cancel();
    },

    deleteExpired(id: string): void {
      // Handed to waitUntil rather than left floating: the response has already
      // been decided by the time this is called, and the runtime would cancel
      // an unregistered promise before the request to B2 completed. The
      // `.catch` is mandatory either way, since an unhandled rejection takes
      // down the request that spawned it.
      waitUntil(
        send("DELETE", id)
          .then((res) => res.body?.cancel())
          .catch((err) => console.error("lazy delete failed", { id, err })),
      );
    },
  };
}

/**
 * B2 answers failures with an XML body. None of it is safe to show a caller, so
 * it is logged and the caller gets the store's generic 503 — the same shape
 * nikednep uses when KV refuses a write.
 */
async function storageFailure(op: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    // A truncated or already-consumed error body is not worth failing over.
  }
  console.error("b2 request failed", { op, status: res.status, detail });
  return ErrStorageUnavailable();
}

/**
 * Rejects anything whose metadata this version cannot read, rather than guessing
 * a default and serving an object with an expiry nobody set. The store is
 * schemaless, so the decode is the schema.
 */
function decode(id: string, headers: Headers): ObjectMeta | null {
  const expiresAtRaw = headers.get(META_EXPIRES_AT);
  if (expiresAtRaw === null) {
    return null;
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }

  // A missing createdAt is survivable — it is informational, and B2's own
  // Last-Modified is a strictly better fallback than discarding the object.
  const createdAt = Number(headers.get(META_CREATED_AT));
  const lastModified = Date.parse(headers.get("last-modified") ?? "");

  const size = Number(headers.get("content-length"));

  return {
    id,
    contentType: headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
    size: Number.isFinite(size) ? size : 0,
    filename: decodeFilename(headers.get(META_FILENAME)),
    // Already quoted by S3, ready to go straight into the header.
    etag: headers.get("etag") ?? "",
    createdAt: new Date(
      Number.isFinite(createdAt) ? createdAt : Number.isFinite(lastModified) ? lastModified : 0,
    ),
    expireAt: new Date(expiresAt),
  };
}

function decodeFilename(raw: string | null): string | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    // Percent-encoded by us on the way in, so this only happens if something
    // else wrote the object. Serve it without a filename rather than 500.
    return undefined;
  }
}
