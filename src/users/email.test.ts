import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emailSchema, normalizeEmail } from "./email.js";

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    assert.equal(normalizeEmail("  Maria.Okafor@Example.COM \n"), "maria.okafor@example.com");
  });
});

describe("emailSchema", () => {
  it("accepts a valid address and returns it normalized", () => {
    assert.equal(emailSchema.parse(" Maria.Okafor@Example.COM "), "maria.okafor@example.com");
    assert.equal(emailSchema.parse("first+tag@sub.example.co.uk"), "first+tag@sub.example.co.uk");
  });

  it("rejects malformed addresses", () => {
    for (const value of ["", "   ", "not-an-email", "user@", "@example.com", "user@localhost", "a b@example.com"]) {
      assert.equal(emailSchema.safeParse(value).success, false, `expected "${value}" to be rejected`);
    }
  });

  it("rejects non-strings and overlong input", () => {
    assert.equal(emailSchema.safeParse(42).success, false);
    assert.equal(emailSchema.safeParse(undefined).success, false);
    assert.equal(emailSchema.safeParse(`${"a".repeat(250)}@example.com`).success, false);
  });
});
