import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ObjectHead } from "../storage/s3.js";
import { inspectStagedObject, REJECTIONS } from "./inspection.js";

const declared = { size: 68, contentType: "image/png", checksumSha256: "ZmFrZS1jaGVja3N1bQ==" };

const head: ObjectHead = {
  size: 68,
  contentType: "image/png",
  eTag: '"abc"',
  cacheControl: "private, no-store",
  contentDisposition: "attachment",
  contentEncoding: undefined,
  contentLanguage: undefined,
  expires: undefined,
  websiteRedirectLocation: undefined,
  metadata: {},
  checksumSha256: "ZmFrZS1jaGVja3N1bQ==",
};

function codeFor(changes: Partial<ObjectHead>): string | undefined {
  return inspectStagedObject(declared, { ...head, ...changes })?.code;
}

describe("inspectStagedObject", () => {
  it("accepts an object that matches what was signed", () => {
    assert.equal(inspectStagedObject(declared, head), undefined);
  });

  it("rejects a different size or type", () => {
    assert.equal(codeFor({ size: 67 }), "size_mismatch");
    assert.equal(codeFor({ contentType: "image/jpeg" }), "type_mismatch");
    assert.equal(codeFor({ contentType: undefined }), "type_mismatch");
  });

  it("rejects headers the server did not choose", () => {
    assert.equal(codeFor({ cacheControl: "public, max-age=31536000" }), "unexpected_metadata");
    assert.equal(codeFor({ cacheControl: undefined }), "unexpected_metadata");
    assert.equal(codeFor({ contentDisposition: "inline" }), "unexpected_metadata");
    assert.equal(codeFor({ contentEncoding: "gzip" }), "unexpected_metadata");
    assert.equal(codeFor({ contentLanguage: "en" }), "unexpected_metadata");
    assert.equal(codeFor({ expires: "Wed, 21 Oct 2026 07:28:00 GMT" }), "unexpected_metadata");
    assert.equal(codeFor({ websiteRedirectLocation: "https://example.com/" }), "unexpected_metadata");
    assert.equal(codeFor({ metadata: { note: "hello" } }), "unexpected_metadata");
  });

  it("rejects a missing or different checksum", () => {
    assert.equal(codeFor({ checksumSha256: undefined }), "checksum_mismatch");
    assert.equal(codeFor({ checksumSha256: "b3RoZXItY2hlY2tzdW0=" }), "checksum_mismatch");
  });

  it("reports the first problem found, with its message", () => {
    const rejection = inspectStagedObject(declared, { ...head, size: 1, contentEncoding: "gzip" });
    assert.deepEqual(rejection, { code: "size_mismatch", message: REJECTIONS.size_mismatch });
  });
});
