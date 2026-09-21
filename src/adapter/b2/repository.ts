import {
  DEFAULT_CONTENT_TYPE,
  MAX_OBJECT_BYTES,
  type NewObject,
  type ObjectMeta,
  type StoredObject,
} from "../../core/storage/entity";
import { ErrStorageUnavailable } from "../../core/storage/errors";
import type { ObjectRepository } from "../../core/storage/ports";
import { GZIP_ENCODING, compress, decompress } from "./compress";
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

/**
 * How the stored bytes are encoded, and how many they were before.
 *
 * Deliberately *not* the standard `Content-Encoding: gzip` on the object, which
 * would be the obvious move and is a trap here. S3 echoes that header back on a
 * GET, and workerd then transparently gunzips the response inside `fetch` —
 * leaving `content-length` describing bytes that no longer exist, HEAD still
 * reporting the compressed size, and this adapter's view of its own objects
 * dependent on runtime behaviour it does not control. A private header keeps the
 * decision explicit and identical on both verbs.
 *
 * `size` is what makes it work: once the body is compressed, B2's
 * `content-length` is no longer the object's length, and `Content-Length` on the
 * way out has to be the decompressed one. It is written on every object,
 * compressed or not, so the two paths decode the same way.
 */
const META_ENCODING = "x-amz-meta-encoding";
const META_SIZE = "x-amz-meta-size";

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
      return decode(id, res.headers)?.meta ?? null;
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

      const decoded = decode(id, res.headers);
      if (decoded === null) {
        // Unusable metadata is not an outage: report a miss so the caller 404s,
        // but log it, because it means something wrote a shape this version does
        // not understand — or wrote straight to the bucket, bypassing the Worker
        // and therefore every check it performs.
        console.error("discarding object with unreadable metadata", { id });
        await res.body?.cancel();
        return null;
      }
      const { meta, encoding } = decoded;

      // Not awaited. The Class B transaction is already spent, but the body is a
      // stream that only transfers when something pulls it, so an object the
      // service throws away for being expired costs no bandwidth and no time —
      // and a gzipped one is never expanded either, since the decompressor only
      // runs when something pulls that same stream.
      return {
        ...meta,
        readBytes:
          encoding === GZIP_ENCODING
            ? () =>
                decompress(res.body, meta.size).catch((err) => {
                  // The bytes are in the bucket but cannot be served: a truncated
                  // object, a bomb written past this Worker, or a length that
                  // disagrees with its metadata. None of that is the caller's
                  // doing, and none of it is a 404 — the object plainly exists.
                  console.error("decompressing stored object failed", { id, err });
                  throw ErrStorageUnavailable();
                })
            : () => res.arrayBuffer(),
      };
    },

    async put(o: NewObject): Promise<void> {
      // Compressed here, after the core has measured and capped the object the
      // caller actually sent. `size` therefore stays the uploaded length
      // everywhere it is reported, and only the bucket sees the smaller body.
      // The content type is passed for the decision only — it is never rewritten.
      const stored = await compress(o.bytes, o.contentType);

      const headers: Record<string, string> = {
        "content-type": o.contentType,
        [META_CREATED_AT]: String(o.createdAt.getTime()),
        [META_EXPIRES_AT]: String(o.expireAt.getTime()),
        [META_SIZE]: String(o.bytes.byteLength),
      };
      if (o.filename !== undefined) {
        headers[META_FILENAME] = encodeURIComponent(o.filename);
      }
      if (stored.encoding !== undefined) {
        headers[META_ENCODING] = stored.encoding;
      }

      const res = await send("PUT", o.id, headers, stored.bytes);
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

/** What the object is, plus how the bucket is holding it. */
interface Decoded {
  meta: ObjectMeta;
  /** `undefined` for bytes stored verbatim, including every pre-gzip object. */
  encoding?: typeof GZIP_ENCODING;
}

/**
 * Rejects anything whose metadata this version cannot read, rather than guessing
 * a default and serving an object with an expiry nobody set. The store is
 * schemaless, so the decode is the schema.
 */
function decode(id: string, headers: Headers): Decoded | null {
  const expiresAtRaw = headers.get(META_EXPIRES_AT);
  if (expiresAtRaw === null) {
    return null;
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }

  // Anything other than absent or gzip is a body this version cannot expand.
  // Serving it raw would hand the caller compressed bytes under the content type
  // of the original, so it is discarded the same way an unreadable expiry is.
  const encodingRaw = headers.get(META_ENCODING);
  if (encodingRaw !== null && encodingRaw !== "" && encodingRaw !== GZIP_ENCODING) {
    return null;
  }
  const encoding = encodingRaw === GZIP_ENCODING ? GZIP_ENCODING : undefined;

  const size = decodeSize(headers, encoding);
  if (size === null) {
    return null;
  }

  // A missing createdAt is survivable — it is informational, and B2's own
  // Last-Modified is a strictly better fallback than discarding the object.
  const createdAt = Number(headers.get(META_CREATED_AT));
  const lastModified = Date.parse(headers.get("last-modified") ?? "");

  return {
    meta: {
      id,
      contentType: headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
      size,
      filename: decodeFilename(headers.get(META_FILENAME)),
      // Already quoted by S3, ready to go straight into the header. It covers
      // the compressed bytes, which is fine: an id is written once and always
      // decompresses to the same body, so it stays a valid strong validator.
      etag: headers.get("etag") ?? "",
      createdAt: new Date(
        Number.isFinite(createdAt) ? createdAt : Number.isFinite(lastModified) ? lastModified : 0,
      ),
      expireAt: new Date(expiresAt),
    },
    ...(encoding === undefined ? {} : { encoding }),
  };
}

/**
 * The object's own length, which is only `content-length` when nothing was
 * compressed.
 *
 * For a gzipped object the stored metadata is the sole source, so it is required
 * and bounded: it is both the `Content-Length` this service will commit to and
 * the ceiling the decompressor is held to, and an unbounded value there is a
 * gzip bomb with permission. For a verbatim object `content-length` remains
 * authoritative — that is what pre-gzip objects have, and the body cannot lie
 * about its own length anyway.
 */
function decodeSize(headers: Headers, encoding: string | undefined): number | null {
  const declared = Number(headers.get(META_SIZE));
  if (encoding === GZIP_ENCODING) {
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_OBJECT_BYTES) {
      return null;
    }
    return declared;
  }

  const contentLength = Number(headers.get("content-length"));
  return Number.isFinite(contentLength) ? contentLength : 0;
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
