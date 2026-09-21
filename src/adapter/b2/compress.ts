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

export interface Compressed {
  bytes: ArrayBuffer;
  /** `undefined` when the bytes are stored verbatim, so no header is written. */
  encoding?: typeof GZIP_ENCODING;
}

/**
 * Both forms are produced and the smaller wins. That means every write gzips,
 * including the ones that end up stored verbatim — a few milliseconds of isolate
 * CPU on a body already capped at 1 MiB, against a permanent decision about
 * billable storage. Guessing from the content type instead would be cheaper and
 * wrong in both directions: `application/octet-stream` is the default here and
 * says nothing, and a `text/csv` full of base64 is not compressible.
 */
export async function compress(bytes: ArrayBuffer): Promise<Compressed> {
  const gzipped = await through(bytes, new CompressionStream(GZIP_ENCODING));
  if (gzipped.byteLength > bytes.byteLength * (1 - MIN_SAVING)) {
    return { bytes };
  }
  return { bytes: gzipped, encoding: GZIP_ENCODING };
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
