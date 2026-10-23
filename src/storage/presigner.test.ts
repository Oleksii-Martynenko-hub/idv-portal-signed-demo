import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { SIGNER_CREDENTIALS, sha256Base64, PNG_BYTES, testConfig, testSigner } from "../test-support.js";
import { CLOCK_SKEW_SECONDS } from "./presigner.js";
import { type AwsCredentials, SignerCredentials } from "./signer-credentials.js";

const KEY = "staging/users/2b0a6f4e-5b5e-4c39-9a53-1f0d3c3a2e11/7f9c2d4e-8a1b-4c3d-9e5f-6a7b8c9d0e1f";
const CHECKSUM = sha256Base64(PNG_BYTES);

function uploadRequest(expiresInSeconds: number) {
  return {
    key: KEY,
    contentType: "image/png",
    size: PNG_BYTES.length,
    cacheControl: "private, no-store",
    contentDisposition: "attachment",
    checksumSha256: CHECKSUM,
    expiresInSeconds,
  };
}

function downloadRequest(expiresInSeconds: number) {
  return {
    key: "files/users/2b0a6f4e-5b5e-4c39-9a53-1f0d3c3a2e11/7f9c2d4e-8a1b-4c3d-9e5f-6a7b8c9d0e1f",
    contentType: "image/png",
    contentDisposition: `inline; filename="passport.png"; filename*=UTF-8''passport.png`,
    expiresInSeconds,
  };
}

function signedHeaders(url: URL): string[] {
  return (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
}

// RFC 3986 encoding, as SigV4 canonicalises the path and the query.
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

// Recomputes the query signature S3 would expect for a PUT that carries `sent`.
function signatureFor(urlString: string, sent: Record<string, string>): string {
  const url = new URL(urlString);
  const query = url.searchParams;
  const names = signedHeaders(url);
  const values = new Map(Object.entries(sent).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const canonicalQuery = [...query.entries()]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .sort()
    .join("&");
  const canonicalPath = url.pathname
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join("/");
  const canonicalRequest = [
    "PUT",
    canonicalPath,
    canonicalQuery,
    names.map((name) => `${name}:${values.get(name) ?? ""}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const [accessKeyId = "", ...scope] = (query.get("X-Amz-Credential") ?? "").split("/");
  assert.equal(accessKeyId, SIGNER_CREDENTIALS.accessKeyId);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    query.get("X-Amz-Date") ?? "",
    scope.join("/"),
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = scope
    .slice(0, 3)
    .reduce<Buffer | string>((key, part) => hmac(key, part), `AWS4${SIGNER_CREDENTIALS.secretAccessKey}`);
  return createHmac("sha256", hmac(signingKey, "aws4_request")).update(stringToSign).digest("hex");
}

describe("UrlSigner.presignUpload", () => {
  it("signs every header the browser must send, and no other", async () => {
    const config = testConfig();
    const { url } = await testSigner(config).presignUpload(uploadRequest(config.uploadUrlTtlSeconds));
    assert.deepEqual(signedHeaders(new URL(url)).sort(), [
      "cache-control",
      "content-disposition",
      "content-length",
      "content-type",
      "host",
      "if-none-match",
      "x-amz-checksum-sha256",
    ]);
  });

  it("signs the values of the returned headers and the declared size", async () => {
    const config = testConfig();
    const request = uploadRequest(config.uploadUrlTtlSeconds);
    const { url, headers } = await testSigner(config).presignUpload(request);
    const sent = { ...headers, host: new URL(url).host, "content-length": String(request.size) };
    const signature = new URL(url).searchParams.get("X-Amz-Signature");

    assert.equal(signatureFor(url, sent), signature);
    const changes: Array<[string, string]> = [
      ["content-length", String(request.size + 1)],
      ["Content-Type", "text/html"],
      ["Cache-Control", "no-cache"],
      ["Content-Disposition", "inline"],
      ["x-amz-checksum-sha256", sha256Base64(Buffer.from("something else"))],
    ];
    for (const [name, value] of changes) {
      assert.notEqual(signatureFor(url, { ...sent, [name]: value }), signature, name);
    }
  });

  it("keeps the checksum a header and adds no checksum of its own", async () => {
    const config = testConfig();
    const { url } = await testSigner(config).presignUpload(uploadRequest(config.uploadUrlTtlSeconds));
    const names = [...new URL(url).searchParams.keys()].map((name) => name.toLowerCase());
    assert.deepEqual(
      names.filter((name) => name.startsWith("x-amz-checksum") || name.startsWith("x-amz-sdk-checksum")),
      [],
    );
  });

  it("expires after the configured upload lifetime", async () => {
    const config = testConfig({ UPLOAD_URL_TTL_SECONDS: "420" });
    const before = Date.now();
    const { url, expiresAt } = await testSigner(config).presignUpload(uploadRequest(config.uploadUrlTtlSeconds));
    const after = Date.now();
    const query = new URL(url).searchParams;
    assert.equal(query.get("X-Amz-Expires"), "420");
    const signedAt = Date.parse(
      (query.get("X-Amz-Date") ?? "").replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
    );
    assert.equal(expiresAt.getTime(), signedAt + 420 * 1000);
    // Signing happens at a whole second between the two clock reads.
    assert.ok(expiresAt.getTime() >= Math.floor(before / 1000) * 1000 + 420 * 1000);
    assert.ok(expiresAt.getTime() <= after + 420 * 1000);
  });

  it("points at the bucket's public origin with the key as the path", async () => {
    const config = testConfig();
    const { url } = await testSigner(config).presignUpload(uploadRequest(config.uploadUrlTtlSeconds));
    const parsed = new URL(url);
    assert.equal(parsed.origin, config.s3PublicOrigin);
    assert.ok(url.startsWith(`${config.s3PublicOrigin}/`));
    assert.equal(parsed.pathname, `/${KEY}`);
    assert.equal(parsed.searchParams.get("X-Amz-Security-Token"), SIGNER_CREDENTIALS.sessionToken);
    assert.match(parsed.searchParams.get("X-Amz-Credential") ?? "", /^ASIATESTSIGNER000001\/\d{8}\/eu-west-1\/s3\/aws4_request$/);
  });

  it("uses path-style URLs on an endpoint override", async () => {
    const config = testConfig({ S3_ENDPOINT: "http://localhost:4566" });
    const { url } = await testSigner(config).presignUpload(uploadRequest(config.uploadUrlTtlSeconds));
    const parsed = new URL(url);
    assert.equal(parsed.origin, config.s3PublicOrigin);
    assert.equal(parsed.pathname, `/${config.s3Bucket}/${KEY}`);
  });

  it("returns the exact headers for the PUT", async () => {
    const config = testConfig();
    const { headers } = await testSigner(config).presignUpload(uploadRequest(config.uploadUrlTtlSeconds));
    assert.deepEqual(headers, {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "attachment",
      "If-None-Match": "*",
      "x-amz-checksum-sha256": CHECKSUM,
    });
  });
});

describe("UrlSigner.presignDownload", () => {
  it("signs a read URL with response overrides and the download lifetime", async () => {
    const config = testConfig({ DOWNLOAD_URL_TTL_SECONDS: "45" });
    const request = downloadRequest(config.downloadUrlTtlSeconds);
    const { url, expiresAt } = await testSigner(config).presignDownload(request);
    const parsed = new URL(url);
    const query = parsed.searchParams;
    assert.equal(parsed.origin, config.s3PublicOrigin);
    assert.equal(parsed.pathname, `/${request.key}`);
    assert.equal(query.get("X-Amz-Expires"), "45");
    assert.equal(query.get("X-Amz-SignedHeaders"), "host");
    assert.equal(query.get("response-content-type"), "image/png");
    assert.equal(query.get("response-content-disposition"), request.contentDisposition);
    assert.equal(query.get("response-cache-control"), "private, no-store");
    assert.equal(query.get("X-Amz-Security-Token"), SIGNER_CREDENTIALS.sessionToken);
    assert.equal(query.get("x-amz-checksum-mode"), null);
    assert.ok(expiresAt.getTime() - Date.now() <= 45 * 1000);
  });
});

describe("UrlSigner credentials", () => {
  it("asks for credentials that outlive the URL by the clock skew allowance", async () => {
    const config = testConfig();
    const asked: number[] = [];
    const credentials = new SignerCredentials(async () => SIGNER_CREDENTIALS);
    const validFor = credentials.validFor.bind(credentials);
    credentials.validFor = (ms: number) => {
      asked.push(ms);
      return validFor(ms);
    };
    const signer = testSigner(config, credentials);
    await signer.presignUpload(uploadRequest(300));
    await signer.presignDownload(downloadRequest(60));
    assert.deepEqual(asked, [(300 + CLOCK_SKEW_SECONDS) * 1000, (60 + CLOCK_SKEW_SECONDS) * 1000]);
  });

  it("signs with the new credentials once they have been refreshed", async () => {
    const config = testConfig();
    let clock = Date.parse("2026-10-23T10:00:00Z");
    let issued = 0;
    const credentials = new SignerCredentials(async (): Promise<AwsCredentials> => {
      issued += 1;
      return {
        accessKeyId: `ASIATESTSIGNER00000${issued}`,
        secretAccessKey: "secret",
        sessionToken: `token-${issued}`,
        expiration: new Date(clock + 60 * 60 * 1000),
      };
    }, () => clock);
    const signer = testSigner(config, credentials);

    const first = new URL((await signer.presignUpload(uploadRequest(300))).url);
    const second = new URL((await signer.presignUpload(uploadRequest(300))).url);
    clock += 56 * 60 * 1000;
    const third = new URL((await signer.presignUpload(uploadRequest(300))).url);

    assert.equal(issued, 2);
    assert.equal(first.searchParams.get("X-Amz-Security-Token"), "token-1");
    assert.equal(second.searchParams.get("X-Amz-Security-Token"), "token-1");
    assert.equal(third.searchParams.get("X-Amz-Security-Token"), "token-2");
    assert.match(third.searchParams.get("X-Amz-Credential") ?? "", /^ASIATESTSIGNER000002\//);
  });

  it("refuses to sign when the credentials cannot cover the URL", async () => {
    const config = testConfig();
    const credentials = new SignerCredentials(async () => ({
      ...SIGNER_CREDENTIALS,
      expiration: new Date(Date.now() + 5 * 60 * 1000),
    }));
    await assert.rejects(testSigner(config, credentials).presignUpload(uploadRequest(300)), /signer session/);
  });
});
