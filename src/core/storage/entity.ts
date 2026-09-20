/**
 * 1 MiB. dpaste — the store this replaces — capped a paste at 750,000 characters,
 * so a mebibyte covers the real workload with room for multi-byte UTF-8.
 *
 * The ceiling is a memory decision more than a product one. The whole body is
 * buffered in the isolate so it can be weighed before it is written, and a Worker
 * isolate gets 128 MB shared across every concurrent request it is handling.
 * Streaming `c.req.raw.body` straight to B2 would lift the cap, at the price of
 * no longer being able to reject a body that lied about its Content-Length — by
 * the time the lie is measurable the bytes are already stored. It would also
 * break request signing, which needs the payload digest up front. That is the
 * boundary at which this design has to change.
 *
 * It is also the abuse ceiling: MAX_OBJECT_BYTES x 20 writes/IP/minute is how fast
 * one address can fill the 10 GB free tier — and unlike the request count, B2
 * bills stored bytes. See README "Free tier".
 */
export const MAX_OBJECT_BYTES = 1024 * 1024;

/** dpaste's expiry_days=7, which is what the calling client asked for. */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Capped at the bucket lifecycle window, not at nikednep's year.
 *
 * B2 has no per-object TTL. Expiry is enforced on read and the only backstop for
 * an object nobody reads again is a lifecycle rule, whose granularity is whole
 * days counted from upload. Raising this to 30 days against a 31-day rule would
 * let a caller ask for `ttl=60` and still occupy a month of billable storage, so
 * the maximum TTL and the rule move together. Longer TTLs want prefix-scoped
 * rules per TTL class, not a bigger number here — see README "Expiry".
 */
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * One second, and it means one second. Expiry is enforced here on read rather
 * than by the store, so there is none of KV's 60-second floor.
 */
export const MIN_TTL_SECONDS = 1;

/**
 * 62^12 is about 3.2e21. Two things ride on this number.
 *
 * Collisions: B2 has no conditional write, so a repeat id would silently
 * overwrite rather than being caught and retried. At 1e6 live objects the
 * birthday probability is ~1.6e-10, which is the whole of the defence.
 *
 * Guessability: there is no auth and no listing, so the id *is* the capability
 * that protects the bytes, and it has to survive being enumerated.
 *
 * Twelve also stays inside the /^[A-Za-z0-9]{6,16}$/ that the dpaste client used
 * to extract ids with, so pointing that client here needs no regex change.
 */
export const GENERATED_ID_LEN = 12;
export const ID_PATTERN = /^[A-Za-z0-9]{12}$/;

/** RFC 9110 8.3: type/subtype plus optional parameters. Long enough for any real
 * media type with a charset and a boundary, short enough to bound the header. */
export const MAX_CONTENT_TYPE_LENGTH = 255;
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** 255 bytes is the filename limit on every filesystem a download will land on. */
export const MAX_FILENAME_LENGTH = 255;

/**
 * An hour. A cached copy must never outlive the object it copies, so the served
 * max-age is the smaller of this and the remaining TTL. This is the second clamp:
 * long enough to make repeat reads free, short enough that a mistake ages out.
 */
export const MAX_CACHE_SECONDS = 3600;

/** What the store holds, minus the bytes. */
export interface ObjectMeta {
  id: string;
  contentType: string;
  size: number;
  filename?: string;
  /** Already quoted, straight from the store's ETag — ready for the header. */
  etag: string;
  createdAt: Date;
  expireAt: Date;
}

/**
 * Metadata plus a body that has not been transferred yet. `readBytes` is a thunk
 * on purpose: an expired object is discarded without ever pulling its body over
 * the wire, and a fetch body does not transfer until something asks it to.
 */
export interface StoredObject extends ObjectMeta {
  readBytes: () => Promise<ArrayBuffer>;
}

/** What the repository is asked to write. */
export interface NewObject {
  id: string;
  bytes: ArrayBuffer;
  contentType: string;
  filename?: string;
  createdAt: Date;
  expireAt: Date;
}

/**
 * Every field is the raw, untouched transport value. The handler narrows types;
 * it does not interpret them, so a bad `ttl` produces this module's own
 * ErrInvalidTTL rather than a silent NaN somewhere upstream. `""` means absent.
 */
export interface CreateCommand {
  declaredLength: string;
  contentType: string;
  filename: string;
  ttlSeconds: string;
  /**
   * Deferred so the core can reject an oversized or malformed upload from its
   * headers alone, without ever buffering it. Validation stays in the core
   * without the core having to know what an HTTP request is.
   */
  readBody: () => Promise<ArrayBuffer>;
  clientIp: string;
  host: string;
  scheme: string;
}

export interface CreateResult extends ObjectMeta {
  url: string;
}

export interface FetchCommand {
  id: string;
  /** Raw `?disposition=`. A preference, not an instruction — see resolveDisposition. */
  disposition: string;
}

/**
 * Everything needed to build a response for an object except the bytes.
 *
 * GET and HEAD both resolve to this, which is the point: RFC 9110 9.3.2 says a
 * HEAD response must carry the same headers a GET would, and the only reliable
 * way to guarantee that is to derive both from one value. An earlier split,
 * where HEAD returned bare metadata, quietly served the stored `text/html`
 * instead of the rewritten type.
 */
export interface ObjectView extends ObjectMeta {
  /**
   * Decided by the core, not the handler: whether a browser may render these
   * bytes is policy. The handler only formats the header.
   */
  disposition: "attachment" | "inline";
  /** The content type that is safe to *serve*, which is not always the one that
   * was stored. See DANGEROUS_TYPES in service.ts. */
  servedContentType: string;
  /** Already clamped to the remaining lifetime. */
  maxAgeSeconds: number;
}

export interface FetchResult extends ObjectView {
  bytes: ArrayBuffer;
}
