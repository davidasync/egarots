/**
 * AWS Signature Version 4, the only auth Backblaze's S3-compatible API accepts
 * (it does not support v2). This is the price of not being on Cloudflare's own
 * network: R2 had a binding, B2 has an HTTP API that has to be signed by hand.
 *
 * Implemented against the SigV4 spec rather than pulled from a library, because
 * every S3 SDK is far larger than the ~100 lines actually needed and none of
 * them are shaped for a Worker. SubtleCrypto provides HMAC-SHA256 and SHA-256
 * natively, so there is no crypto here beyond wiring.
 */

const ENCODER = new TextEncoder();
const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to send. `host`, `x-amz-date` and `x-amz-content-sha256` are added here. */
  headers: Record<string, string>;
  /** Absent for GET/HEAD/DELETE. */
  body?: ArrayBuffer;
  keyId: string;
  appKey: string;
  region: string;
  now: Date;
}

/** Returns the full header set to send, including `Authorization`. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = timestamps(input.now);

  // B2 does not document support for UNSIGNED-PAYLOAD, so the real digest is
  // always computed. SubtleCrypto's SHA-256 is native and handles a megabyte in
  // a couple of milliseconds, which fits the Free plan's 10ms CPU budget — but
  // it is the reason MAX_OBJECT_BYTES cannot grow without re-measuring.
  const payloadHash = await sha256Hex(input.body ?? new ArrayBuffer(0));

  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  // Canonical headers: lowercase name, collapsed value, sorted by name.
  const canonicalEntries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = canonicalEntries.map(([n, v]) => `${n}:${v}\n`).join("");
  const signedHeaders = canonicalEntries.map(([n]) => n).join(";");

  const canonicalRequest = [
    input.method,
    canonicalPath(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const signature = hex(await hmac(await signingKey(input.appKey, dateStamp, input.region), stringToSign));

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${input.keyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Each path segment is encoded, but the separators are not — S3 signs the path
 * as it appears on the wire. Object ids here are alphanumeric so this is a no-op
 * in practice; it exists so a bucket name with a character worth encoding does
 * not silently produce a signature mismatch.
 */
function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeRFC3986(encodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([k, v]) => [encodeRFC3986(encodeURIComponent(k)), encodeRFC3986(encodeURIComponent(v))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** encodeURIComponent leaves these alone; SigV4 requires them percent-encoded. */
function encodeRFC3986(value: string): string {
  return value.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function signingKey(appKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmac(ENCODER.encode(`AWS4${appKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, ENCODER.encode(data));
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes: BufferSource = typeof data === "string" ? ENCODER.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `20260920T093000Z` for the signature, `20260920` for the credential scope. */
function timestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}
