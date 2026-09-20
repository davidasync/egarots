import { signRequest } from "../src/adapter/b2/sigv4.ts";

// NOTE ON THE CREDENTIALS BELOW: they are not secrets and never were. AWS
// publishes this exact key pair in its Signature Version 4 documentation so
// that implementations can be checked against a known-good signature. They
// authenticate nothing. Any scanner flagging `AKIAIOSFODNN7EXAMPLE` is matching
// the shape, not a leak — the string literally ends in "EXAMPLE".

// Official AWS SigV4 test vector: "GET Object" example from the Amazon S3
// signature documentation. If our signer matches this byte for byte, the
// canonical request, string-to-sign and signing key derivation are all correct.
const res = await signRequest({
  method: "GET",
  url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
  headers: { range: "bytes=0-9" },
  keyId: "AKIAIOSFODNN7EXAMPLE",
  appKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  now: new Date("2013-05-24T00:00:00Z"),
});

const EXPECTED = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";
const got = /Signature=([0-9a-f]+)/.exec(res.Authorization)?.[1] ?? "";

console.log("x-amz-date:      ", res["x-amz-date"]);
console.log("content-sha256:  ", res["x-amz-content-sha256"]);
console.log("authorization:   ", res.Authorization);
console.log();
console.log("expected sig:    ", EXPECTED);
console.log("got sig:         ", got);
console.log(got === EXPECTED ? "\n*** SIGV4 CORRECT ***" : "\n*** SIGV4 MISMATCH ***");
process.exit(got === EXPECTED ? 0 : 1);
