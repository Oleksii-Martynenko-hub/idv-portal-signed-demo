import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GIF_BYTES, HTML_BYTES, JPEG_BYTES, PNG_BYTES, TEXT_BYTES, WEBP_BYTES } from "../test-support.js";
import { detectImageType, extensionFor, isImageType } from "./file-type.js";

describe("detectImageType", () => {
  it("recognises the accepted image formats from their bytes", async () => {
    assert.equal(await detectImageType(JPEG_BYTES), "image/jpeg");
    assert.equal(await detectImageType(PNG_BYTES), "image/png");
    assert.equal(await detectImageType(WEBP_BYTES), "image/webp");
  });

  it("rejects anything that is not one of them", async () => {
    assert.equal(await detectImageType(HTML_BYTES), undefined);
    assert.equal(await detectImageType(TEXT_BYTES), undefined);
    assert.equal(await detectImageType(GIF_BYTES), undefined);
    assert.equal(await detectImageType(Buffer.alloc(0)), undefined);
  });
});

describe("extensionFor", () => {
  it("maps each type to a file extension", () => {
    assert.equal(extensionFor("image/jpeg"), "jpg");
    assert.equal(extensionFor("image/png"), "png");
    assert.equal(extensionFor("image/webp"), "webp");
  });
});

describe("isImageType", () => {
  it("accepts the declared types the portal takes", () => {
    assert.equal(isImageType("image/jpeg"), true);
    assert.equal(isImageType("image/png"), true);
    assert.equal(isImageType("image/webp"), true);
    assert.equal(isImageType("image/gif"), false);
    assert.equal(isImageType("IMAGE/PNG"), false);
    assert.equal(isImageType(undefined), false);
  });
});
