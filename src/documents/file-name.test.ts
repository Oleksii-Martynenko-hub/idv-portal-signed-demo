import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentDisposition, sanitizeFileName } from "./file-name.js";

describe("sanitizeFileName", () => {
  it("keeps an ordinary name", () => {
    assert.equal(sanitizeFileName("passport.jpg", "jpg"), "passport.jpg");
    assert.equal(sanitizeFileName("Паспорт (скан).png", "png"), "Паспорт (скан).png");
  });

  it("drops directory parts and control characters", () => {
    assert.equal(sanitizeFileName("C:\\Users\\maria\\passport.jpg", "jpg"), "passport.jpg");
    assert.equal(sanitizeFileName("../../etc/passwd", "png"), "passwd");
    assert.equal(sanitizeFileName("scan\u0000\u001f.png", "png"), "scan.png");
  });

  it("falls back to a generated name", () => {
    assert.equal(sanitizeFileName(undefined, "png"), "document.png");
    assert.equal(sanitizeFileName("   ", "webp"), "document.webp");
    assert.equal(sanitizeFileName("..", "jpg"), "document.jpg");
    assert.equal(sanitizeFileName("photos/", "jpg"), "document.jpg");
  });

  it("limits the length", () => {
    assert.equal(sanitizeFileName("x".repeat(500), "png").length, 200);
  });

  it("replaces unpaired surrogates and keeps paired ones", () => {
    assert.equal(sanitizeFileName("scan\ud800.png", "png"), "scan�.png");
    assert.equal(sanitizeFileName("\udc00scan.png", "png"), "�scan.png");
    assert.equal(sanitizeFileName("scan\udc00\ud800.png", "png"), "scan��.png");
    assert.equal(sanitizeFileName("scan 📷.png", "png"), "scan 📷.png");
    assert.doesNotThrow(() => contentDisposition(sanitizeFileName("scan\ud800.png", "png")));
  });
});

describe("contentDisposition", () => {
  it("uses the name as-is when it is plain ASCII", () => {
    assert.equal(contentDisposition("passport.jpg"), `inline; filename="passport.jpg"; filename*=UTF-8''passport.jpg`);
  });

  it("escapes quotes and encodes non-ASCII characters", () => {
    assert.equal(
      contentDisposition('my "id" (1).png'),
      `inline; filename="my _id_ (1).png"; filename*=UTF-8''my%20%22id%22%20%281%29.png`,
    );
    assert.equal(contentDisposition("Паспорт.png"), `inline; filename="_______.png"; filename*=UTF-8''%D0%9F%D0%B0%D1%81%D0%BF%D0%BE%D1%80%D1%82.png`);
  });
});
