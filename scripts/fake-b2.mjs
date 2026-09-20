// A minimal stand-in for Backblaze's S3-compatible API.
//
// It does NOT just accept whatever arrives: it recomputes the AWS SigV4
// signature from the incoming request and rejects a mismatch with 403, exactly
// as B2 would. That makes this a real test of the signer, not a smoke test of
// the plumbing around it.
import http from "node:http";
import crypto from "node:crypto";

// Fixed fakes. This server is a local test double; these are the values it
// expects .dev.vars to carry when running `make dev-fake`, and they grant
// access to nothing.
const KEY_ID = "test-key-id";
const APP_KEY = "test-app-key";
const REGION = "us-west-004";
const PORT = 9000;

const store = new Map(); // key -> { body: Buffer, headers: {} }

const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

function expectedSignature(req, bodyBuf, signedHeaderNames, amzDate, dateStamp) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const canonicalHeaders = signedHeaderNames
    .map((n) => `${n}:${String(req.headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const payloadHash = req.headers["x-amz-content-sha256"];

  const canonicalQuery = [...url.searchParams]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    req.method,
    url.pathname.split("/").map((s) => encodeURIComponent(s)).join("/"),
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");

  // Verify the client's declared payload hash actually matches the body.
  if (payloadHash !== sha256hex(bodyBuf)) return { err: "payload hash mismatch" };

  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  let k = hmac(`AWS4${APP_KEY}`, dateStamp);
  k = hmac(k, REGION);
  k = hmac(k, "s3");
  k = hmac(k, "aws4_request");
  return { sig: hmac(k, stringToSign).toString("hex") };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const auth = req.headers.authorization ?? "";
    const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);

    if (!m) return fail(res, 403, "malformed Authorization");
    const [, keyId, dateStamp, region, signedHeaders, given] = m;
    if (keyId !== KEY_ID) return fail(res, 403, "unknown key id");
    if (region !== REGION) return fail(res, 403, "wrong region");

    const { sig, err } = expectedSignature(
      req, body, signedHeaders.split(";"), req.headers["x-amz-date"], dateStamp,
    );
    if (err) return fail(res, 403, err);
    if (sig !== given) {
      console.log(`  [fake-b2] SIGNATURE MISMATCH ${req.method} ${req.url}`);
      return fail(res, 403, "SignatureDoesNotMatch");
    }

    // Signature verified — behave like a bucket.
    const key = decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/^\/[^/]+\//, ""));
    console.log(`  [fake-b2] ${req.method} ${key} sig-ok`);

    if (req.method === "PUT") {
      const meta = {};
      for (const [h, v] of Object.entries(req.headers)) {
        if (h.startsWith("x-amz-meta-")) meta[h] = v;
      }
      meta["content-type"] = req.headers["content-type"] ?? "application/octet-stream";
      store.set(key, { body, meta, etag: `"${crypto.createHash("md5").update(body).digest("hex")}"` });
      res.writeHead(200, { ETag: store.get(key).etag }); return res.end();
    }

    const obj = store.get(key);
    if (req.method === "DELETE") { store.delete(key); res.writeHead(204); return res.end(); }
    if (!obj) return fail(res, 404, "NoSuchKey");

    const headers = {
      ...obj.meta,
      "Content-Length": String(obj.body.length),
      ETag: obj.etag,
      "Last-Modified": new Date().toUTCString(),
    };
    if (req.method === "HEAD") { res.writeHead(200, headers); return res.end(); }
    if (req.method === "GET") { res.writeHead(200, headers); return res.end(obj.body); }
    return fail(res, 405, "method not allowed");
  });
});

function fail(res, code, msg) {
  res.writeHead(code, { "Content-Type": "application/xml" });
  res.end(`<Error><Code>${msg}</Code></Error>`);
}

server.listen(PORT, "127.0.0.1", () => console.log(`fake-b2 listening on ${PORT}`));
