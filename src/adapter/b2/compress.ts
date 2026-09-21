/**
 * Gzip on the way into the bucket, gunzip on the way out.
 *
 * B2 bills stored bytes, and the bodies this service holds are overwhelmingly
 * text — a paste store's workload compresses to a fifth of its size or better.
 * Compression is a storage concern, so it lives beside the adapter that pays for
 * it: the core still measures, caps and reports the object the caller uploaded,
 * and nothing above this file knows the bucket holds something smaller.
 *
 * `CompressionStream`/`DecompressionStream` are part of workerd, so this costs
 * no dependency and no wasm.
 */

/** Value of the `encoding` metadata header for a gzipped body. */
export const GZIP_ENCODING = "gzip";

/**
 * Below this saving, the object is stored as-is.
 *
 * Gzip on already-compressed bytes — jpeg, png, zip, another gzip — returns
 * the input plus a header, so a blind compress would *add* stored bytes to the
 * exact objects that are largest. A read also pays CPU to undo it, which is only
 * worth spending when there is real space behind it. 5% is the line: text clears
 * it by an order of magnitude, media never comes close.
 */
const MIN_SAVING = 0.05;

/**
 * 256 KiB. Above this the body is stored verbatim without even being tried.
 *
 * This is a **CPU** limit, not a storage one, and it exists because gzip costs
 * time in proportion to the bytes fed in rather than to the bytes it saves.
 * Measured on this Worker in production, via `wrangler tail`:
 *
 *   15 B upload .................. 13 ms CPU   (isolate start + SigV4, no gzip)
 *   1 MB upload, gzipped ......... 60 ms CPU
 *   1 MB read, gunzipped ......... 36 ms CPU
 *
 * The Workers **free plan allows 10 ms of CPU per invocation**. It tolerates
 * infrequent overage, but a Worker that exceeds the limit consistently has its
 * requests terminated with a 1102, so 60 ms is not somewhere to sit. 256 KiB
 * keeps the compression step near 10 ms of edge CPU on the worst case, which
 * brings a large write back to roughly 20 ms rather than 60 ms.
 *
 * The baseline is the part worth remembering: at 13 ms, a *15-byte* upload is
 * already over the free limit, so no compression policy can get this Worker
 * under it. Signing is what costs that, and it is not optional — SigV4 needs a
 * SHA-256 of the whole payload up front. The aim here is a small, occasional
 * overage instead of a permanent 6x one.
 */
const MAX_COMPRESS_BYTES = 256 * 1024;

/**
 * Types whose bytes are already deflate-, JPEG- or similarly compressed. Gzip
 * returns these near-unchanged, so the work is spent for nothing.
 *
 * Enumerated rather than matched by prefix, deliberately. `image/*` would also
 * catch bmp, tiff and ico, and `audio/*` would catch wav and aiff — all of them
 * raw sample or pixel data that compresses like text. A prefix rule would quietly
 * decline the best savings in each family to save typing here.
 *
 * This cannot be complete and does not need to be: it is an optimisation, and
 * `MIN_SAVING` still catches anything that slips through, at the price of the CPU
 * spent finding out. An upload sent as `application/octet-stream` — the default
 * when a caller says nothing — is exactly that case.
 */
const PRECOMPRESSED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/jxl",
  "video/mp4",
  "video/mpeg",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/flac",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/x-7z-compressed",
  "application/vnd.rar",
  // Every OOXML document is a zip archive wearing a long name.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export interface Compressed {
  bytes: ArrayBuffer;
  /** `undefined` when the bytes are stored verbatim, so no header is written. */
  encoding?: typeof GZIP_ENCODING;
}

/**
 * Both forms are produced and the smaller wins — for the bodies still worth
 * trying. Measuring beats guessing, because `application/octet-stream` is the
 * default here and says nothing, and a `text/csv` full of base64 does not
 * compress; the two rules below only decline the cases where the measurement
 * reliably costs more CPU than the answer is worth.
 */
export async function compress(bytes: ArrayBuffer, contentType: string): Promise<Compressed> {
  if (!worthTrying(contentType, bytes.byteLength)) {
    return { bytes };
  }

  const gzipped = await through(bytes, new CompressionStream(GZIP_ENCODING));
  if (gzipped.byteLength > bytes.byteLength * (1 - MIN_SAVING)) {
    return { bytes };
  }
  return { bytes: gzipped, encoding: GZIP_ENCODING };
}

/**
 * The two cases where compressing is known to be a poor trade, checked before
 * any CPU is spent.
 *
 * Size comes first because it is the one that bounds the worst case: it holds
 * whatever the type claims, including the `octet-stream` default that claims
 * nothing. The type check then earns its place *below* the ceiling, where a
 * small jpeg would otherwise be compressed for approximately zero gain.
 */
function worthTrying(contentType: string, size: number): boolean {
  if (size > MAX_COMPRESS_BYTES) {
    return false;
  }
  const type = essence(contentType);
  // `+zip` covers the structured-suffix archives — epub, and anything else that
  // followed RFC 6839 rather than inventing a name.
  return !PRECOMPRESSED_TYPES.has(type) && !type.endsWith("+zip");
}

/**
 * `text/plain; charset=utf-8` -> `text/plain`. The core has its own copy of this
 * for deciding what is safe to *serve*; duplicating three lines is better than
 * exporting an internal from `core/storage/service.ts` so that an adapter can
 * reach into it.
 */
function essence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Expands a stored body, refusing to produce more than `size` bytes.
 *
 * The cap is not paranoia about our own writes — those were measured before they
 * were compressed. It is that the bucket is reachable without going through this
 * Worker, and a gzip bomb written straight into it would otherwise expand inside
 * an isolate that has 128 MB to share across every request in flight. The
 * declared size is the only statement of intent available before expanding, so
 * it is enforced as a hard stop and then checked for having been met exactly:
 * a body that decompresses to a different length than advertised would make the
 * `Content-Length` this service has already committed to a lie.
 */
export async function decompress(
  body: ReadableStream<Uint8Array> | null,
  size: number,
): Promise<ArrayBuffer> {
  if (body === null) {
    // A 200 always has a body; this keeps the types honest without inventing a
    // failure mode that the store cannot actually produce.
    return new ArrayBuffer(0);
  }

  const bytes = await new Response(
    body.pipeThrough(new DecompressionStream(GZIP_ENCODING)).pipeThrough(cappedAt(size)),
  ).arrayBuffer();

  if (bytes.byteLength !== size) {
    throw new Error(`decompressed to ${bytes.byteLength} bytes, metadata said ${size}`);
  }
  return bytes;
}

/**
 * Errors the stream the moment the limit is passed, rather than after. The
 * chunk that crosses it is never enqueued, so the buffered output stays bounded
 * by `limit` plus one chunk of the decompressor's own making.
 */
function cappedAt(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        controller.error(new Error(`body expands past the declared ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** Buffered, not streamed: signing needs the payload digest of the whole body. */
async function through(
  bytes: ArrayBuffer,
  transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<ArrayBuffer> {
  const source = new Response(bytes).body;
  if (source === null) {
    return bytes;
  }
  return new Response(source.pipeThrough(transform)).arrayBuffer();
}
