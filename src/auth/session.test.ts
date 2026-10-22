import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSessionCookie,
  generateSessionToken,
  hashSessionToken,
  readSessionToken,
  SESSION_COOKIE,
  serializeSessionCookie,
} from "./session.js";

describe("generateSessionToken", () => {
  it("returns 256 bits as base64url", () => {
    const token = generateSessionToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.notEqual(generateSessionToken(), token);
  });
});

describe("hashSessionToken", () => {
  it("is the hex SHA-256 of the token", () => {
    assert.equal(hashSessionToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(hashSessionToken("abc"), hashSessionToken("abc"));
    assert.notEqual(hashSessionToken("abc"), hashSessionToken("abd"));
  });
});

describe("serializeSessionCookie", () => {
  it("sets the session attributes", () => {
    const token = generateSessionToken();
    const cookie = serializeSessionCookie(token, { maxAgeSeconds: 604800, secure: false });
    assert.equal(SESSION_COOKIE, "sid");
    assert.ok(cookie.startsWith(`sid=${token};`));
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Max-Age=604800/);
    assert.doesNotMatch(cookie, /Secure/);
  });

  it("marks the cookie Secure when asked", () => {
    assert.match(serializeSessionCookie(generateSessionToken(), { maxAgeSeconds: 60, secure: true }), /; Secure/);
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately", () => {
    const cookie = clearSessionCookie({ secure: false });
    assert.ok(cookie.startsWith("sid=;"));
    assert.match(cookie, /; Max-Age=0/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
  });
});

describe("readSessionToken", () => {
  it("finds the session cookie among others", () => {
    const token = generateSessionToken();
    assert.equal(readSessionToken(`theme=dark; sid=${token}; lang=en`), token);
  });

  it("ignores missing or malformed values", () => {
    assert.equal(readSessionToken(undefined), undefined);
    assert.equal(readSessionToken(""), undefined);
    assert.equal(readSessionToken("theme=dark"), undefined);
    assert.equal(readSessionToken("sid=not-a-token"), undefined);
    assert.equal(readSessionToken(`sid=${"a".repeat(44)}`), undefined);
    assert.equal(readSessionToken("sid=abc+def/ghi=" + "a".repeat(30)), undefined);
  });
});
