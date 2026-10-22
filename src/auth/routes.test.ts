import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import request from "supertest";
import { createTestApp, currentUserId, SAME_ORIGIN, signIn } from "../test-support.js";
import { hashSessionToken } from "./session.js";

describe("POST /auth/sign-in", () => {
  it("creates the user when the email is unknown and starts a session", async () => {
    const { app, dynamodb, table } = createTestApp();

    const response = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).send({ email: "Maria@Example.com" });

    assert.equal(response.status, 204);
    const cookie = (response.get("Set-Cookie") ?? [])[0] ?? "";
    assert.match(cookie, /^sid=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Max-Age=604800/);
    assert.doesNotMatch(cookie, /Secure/);

    const writes = dynamodb.commandCalls(TransactWriteCommand);
    assert.equal(writes.length, 1);
    const puts = writes[0]?.args[0].input.TransactItems?.map((item) => item.Put) ?? [];
    assert.equal(puts.length, 2);
    assert.ok(puts.every((put) => put?.ConditionExpression === "attribute_not_exists(PK)"));
    assert.equal(puts[0]?.Item?.PK, "EMAIL#maria@example.com");
    assert.equal(puts[0]?.Item?.SK, "USER");
    assert.equal(puts[1]?.Item?.SK, "PROFILE");
    assert.equal(puts[1]?.Item?.email, "maria@example.com");

    const token = cookie.slice("sid=".length, cookie.indexOf(";"));
    const session = table.find(`SESSION#${hashSessionToken(token)}`, "SESSION");
    assert.ok(session, "session item was not written");
    assert.equal(session.userId, puts[0]?.Item?.userId);
    assert.equal(typeof session.ttl, "number");
    assert.ok(Date.parse(String(session.expiresAt)) > Date.now());
  });

  it("reuses the existing user for a known email, whatever the casing", async () => {
    const { app, dynamodb } = createTestApp();

    const first = await signIn(app, "maria@example.com");
    const second = await signIn(app, "  MARIA@example.COM ");

    assert.equal(dynamodb.commandCalls(TransactWriteCommand).length, 1);
    assert.equal(await currentUserId(app, first), await currentUserId(app, second));
  });

  it("replaces the session a signed-in browser already holds", async () => {
    const { app } = createTestApp();
    const first = await signIn(app, "maria@example.com");

    const response = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).set("Cookie", first).send({ email: "maria@example.com" });

    assert.equal(response.status, 204);
    const second = (response.get("Set-Cookie") ?? [])[0]?.split(";")[0] ?? "";
    assert.match(second, /^sid=/);
    assert.notEqual(second, first);
    await request(app).get("/api/me").set("Cookie", first).expect(401);
    await request(app).get("/api/me").set("Cookie", second).expect(200);
  });

  it("rejects invalid input", async () => {
    const { app } = createTestApp();
    for (const body of [{ email: "nope" }, { email: "" }, {}, { email: 42 }]) {
      const response = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).send(body);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "invalid_email");
    }
    const notJson = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).type("text").send("maria@example.com");
    assert.equal(notJson.status, 400);
  });

  it("rejects cross-site requests", async () => {
    const { app, dynamodb } = createTestApp();
    const response = await request(app)
      .post("/auth/sign-in")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ email: "maria@example.com" });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "cross_site_request");
    assert.equal(dynamodb.calls().length, 0);
  });

  it("marks the cookie Secure in production", async () => {
    const { app } = createTestApp({ NODE_ENV: "production" });
    const response = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).send({ email: "maria@example.com" });
    assert.equal(response.status, 204);
    assert.match((response.get("Set-Cookie") ?? [])[0] ?? "", /; Secure/);
  });

  it("is rate limited per client", async () => {
    const { app } = createTestApp();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await request(app).post("/auth/sign-in").set(SAME_ORIGIN).send({ email: `user${attempt}@example.com` }).expect(204);
    }
    const response = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).send({ email: "user21@example.com" });
    assert.equal(response.status, 429);
    assert.equal(response.body.error.code, "too_many_requests");
  });
});

describe("POST /auth/sign-out", () => {
  it("deletes the session and clears the cookie", async () => {
    const { app, table } = createTestApp();
    const cookie = await signIn(app, "maria@example.com");
    assert.equal(table.withPrefix(`SESSION#${hashSessionToken(cookie.slice("sid=".length))}`, "SESSION").length, 1);

    const response = await request(app).post("/auth/sign-out").set(SAME_ORIGIN).set("Cookie", cookie);

    assert.equal(response.status, 204);
    assert.match((response.get("Set-Cookie") ?? [])[0] ?? "", /^sid=; .*Max-Age=0/);
    assert.equal(table.withPrefix(`SESSION#${hashSessionToken(cookie.slice("sid=".length))}`, "SESSION").length, 0);
    await request(app).get("/api/me").set("Cookie", cookie).expect(401);
  });

  it("succeeds without a session", async () => {
    const { app } = createTestApp();
    await request(app).post("/auth/sign-out").set(SAME_ORIGIN).expect(204);
  });
});

describe("GET /api/me", () => {
  it("returns the signed-in user", async () => {
    const { app } = createTestApp();
    const cookie = await signIn(app, "Maria@Example.com");

    const response = await request(app).get("/api/me").set("Cookie", cookie).expect(200);

    assert.match(response.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(response.body.email, "maria@example.com");
    assert.ok(Date.parse(response.body.createdAt));
    assert.deepEqual(Object.keys(response.body).sort(), ["createdAt", "email", "id"]);
  });

  it("rejects missing, unknown and expired sessions", async () => {
    const { app, table } = createTestApp();
    const unauthenticated = await request(app).get("/api/me").expect(401);
    assert.equal(unauthenticated.body.error.code, "unauthenticated");
    await request(app).get("/api/me").set("Cookie", `sid=${"x".repeat(43)}`).expect(401);

    const cookie = await signIn(app, "maria@example.com");
    const key = `SESSION#${hashSessionToken(cookie.slice("sid=".length))}`;
    const session = table.find(key, "SESSION");
    assert.ok(session);
    table.insert({ ...session, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await request(app).get("/api/me").set("Cookie", cookie).expect(401);
  });
});
