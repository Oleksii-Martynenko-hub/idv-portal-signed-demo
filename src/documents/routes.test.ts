import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import request from "supertest";
import { SignerCredentials } from "../storage/signer-credentials.js";
import { createTestApp, currentUserId, PNG_BYTES, SAME_ORIGIN, signIn, type TestApp, uploadDocument } from "../test-support.js";

function insertReceived(context: TestApp, userId: string, fields: Record<string, unknown> = {}): string {
  const id = randomUUID();
  context.table.insert({
    PK: `USER#${userId}`,
    SK: `DOC#${id}`,
    documentId: id,
    userId,
    kind: "id_card",
    fileName: "id.jpg",
    contentType: "image/jpeg",
    size: 10,
    s3Key: `files/users/${userId}/${id}`,
    status: "received",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  });
  return id;
}

function insertRejected(context: TestApp, userId: string): string {
  const id = randomUUID();
  context.table.insert({
    PK: `USER#${userId}`,
    SK: `DOC#${id}`,
    documentId: id,
    userId,
    kind: "passport",
    fileName: "passport.png",
    contentType: "image/png",
    size: 80,
    status: "rejected",
    rejectionCode: "unsupported_file_type",
    rejectionReason: "The file is not a JPEG, PNG or WebP image.",
    createdAt: "2026-03-01T00:00:00.000Z",
  });
  return id;
}

describe("GET /api/documents", () => {
  it("lists the caller's documents, newest first, each with a short-lived read URL", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const older = insertReceived(context, userId, { createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = insertReceived(context, userId, { createdAt: "2026-02-01T00:00:00.000Z", fileName: "Посвідчення.jpg" });
    insertReceived(context, "someone-else", { createdAt: "2026-03-01T00:00:00.000Z" });

    const before = Date.now();
    const response = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);

    const { documents } = response.body;
    assert.deepEqual(
      documents.map((document: { id: string }) => document.id),
      [newer, older],
    );
    const [first] = documents;
    assert.deepEqual(Object.keys(first).sort(), [
      "contentType",
      "createdAt",
      "fileName",
      "id",
      "kind",
      "size",
      "status",
      "url",
      "urlExpiresAt",
    ]);
    const url = new URL(first.url);
    assert.equal(url.origin, context.config.s3PublicOrigin);
    assert.equal(url.pathname, `/files/users/${userId}/${newer}`);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
    assert.equal(url.searchParams.get("response-content-type"), "image/jpeg");
    assert.equal(
      url.searchParams.get("response-content-disposition"),
      `inline; filename="___________.jpg"; filename*=UTF-8''%D0%9F%D0%BE%D1%81%D0%B2%D1%96%D0%B4%D1%87%D0%B5%D0%BD%D0%BD%D1%8F.jpg`,
    );
    const expiresAt = Date.parse(first.urlExpiresAt);
    assert.ok(expiresAt > before + 58 * 1000 && expiresAt <= Date.now() + 60 * 1000);
    // Signing is local; listing never calls S3.
    assert.equal(context.s3.calls().length, 0);
  });

  it("follows the configured read URL lifetime", async () => {
    const context = createTestApp({ DOWNLOAD_URL_TTL_SECONDS: "30" });
    const cookie = await signIn(context.app, "maria@example.com");
    insertReceived(context, await currentUserId(context.app, cookie));
    const response = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);
    assert.equal(new URL(response.body.documents[0].url).searchParams.get("X-Amz-Expires"), "30");
  });

  it("gives rejected documents their reason and no URL", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const id = insertRejected(context, await currentUserId(context.app, cookie));

    const response = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);

    assert.deepEqual(response.body.documents, [
      {
        id,
        kind: "passport",
        fileName: "passport.png",
        contentType: "image/png",
        size: 80,
        status: "rejected",
        createdAt: "2026-03-01T00:00:00.000Z",
        rejectionReason: "The file is not a JPEG, PNG or WebP image.",
      },
    ]);
  });

  it("signs only the promoted key of the caller's own document", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const elsewhere = insertReceived(context, userId, { s3Key: "files/users/someone-else/their-document" });
    const staged = insertReceived(context, userId, { createdAt: "2026-01-02T00:00:00.000Z" });
    const stagedRecord = context.table.find(`USER#${userId}`, `DOC#${staged}`);
    assert.ok(stagedRecord);
    stagedRecord.s3Key = `staging/users/${userId}/${staged}`;
    const good = insertReceived(context, userId, { createdAt: "2026-01-03T00:00:00.000Z" });

    const response = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);

    const byId = new Map(response.body.documents.map((document: { id: string }) => [document.id, document]));
    assert.equal((byId.get(elsewhere) as { url?: string }).url, undefined);
    assert.equal((byId.get(staged) as { url?: string }).url, undefined);
    assert.equal(new URL((byId.get(good) as { url: string }).url).pathname, `/files/users/${userId}/${good}`);
  });

  it("answers 502 when read URLs cannot be signed", async () => {
    const context = createTestApp(
      {},
      {
        signerCredentials: new SignerCredentials(async () => {
          throw new Error("AssumeRole failed");
        }),
      },
    );
    const cookie = await signIn(context.app, "maria@example.com");
    insertReceived(context, await currentUserId(context.app, cookie));

    const response = await request(context.app).get("/api/documents").set("Cookie", cookie);

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "storage_unavailable");
  });

  it("requires a session", async () => {
    const { app } = createTestApp();
    await request(app).get("/api/documents").expect(401);
  });

  it("has no route that streams a document's bytes", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const id = await uploadDocument(context, cookie, PNG_BYTES);
    context.s3.resetHistory();

    await request(context.app).get(`/api/documents/${id}/file`).set("Cookie", cookie).expect(404);
    assert.equal(context.s3.calls().length, 0);
  });
});

describe("DELETE /api/documents/:id", () => {
  it("removes the promoted object and then the record", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = await uploadDocument(context, cookie, PNG_BYTES);
    context.s3.resetHistory();

    await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie).expect(204);

    assert.deepEqual(
      context.s3.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input),
      [{ Bucket: context.config.s3Bucket, Key: `files/users/${userId}/${id}` }],
    );
    assert.equal(context.table.find(`USER#${userId}`, `DOC#${id}`), undefined);
    const list = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);
    assert.deepEqual(list.body, { documents: [] });
  });

  it("removes a rejected document's record and any promoted copy left behind", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = insertRejected(context, userId);
    context.s3.on(DeleteObjectCommand).resolves({});

    await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie).expect(204);

    assert.deepEqual(
      context.s3.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input),
      [{ Bucket: context.config.s3Bucket, Key: `files/users/${userId}/${id}` }],
    );
    assert.equal(context.table.find(`USER#${userId}`, `DOC#${id}`), undefined);
  });

  it("removes a rejected document even when the leftover copy cannot be deleted", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = insertRejected(context, userId);
    context.s3.on(DeleteObjectCommand).rejects(new Error("access denied"));

    await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie).expect(204);

    assert.equal(context.table.find(`USER#${userId}`, `DOC#${id}`), undefined);
  });

  it("keeps a document whose stored key is not where this service keeps the file", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const elsewhere = insertReceived(context, userId, { s3Key: "files/users/someone-else/their-document" });
    const unexpected = insertReceived(context, userId);
    const record = context.table.find(`USER#${userId}`, `DOC#${unexpected}`);
    assert.ok(record);
    record.s3Key = `users/${userId}/documents/${unexpected}`;
    context.s3.on(DeleteObjectCommand).resolves({});

    for (const id of [elsewhere, unexpected]) {
      const response = await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie);

      assert.equal(response.status, 500, id);
      assert.equal(response.body.error.code, "internal_error", id);
      assert.ok(context.table.find(`USER#${userId}`, `DOC#${id}`), id);
    }
    assert.equal(context.s3.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("keeps the record when the object cannot be deleted", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = insertReceived(context, userId);
    context.s3.on(DeleteObjectCommand).rejects(new Error("access denied"));

    const response = await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie);

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "storage_unavailable");
    assert.ok(context.table.find(`USER#${userId}`, `DOC#${id}`));
  });

  it("answers 404 for documents of other users and rejects cross-site requests", async () => {
    const context = createTestApp();
    const owner = await signIn(context.app, "owner@example.com");
    const other = await signIn(context.app, "other@example.com");
    const ownerId = await currentUserId(context.app, owner);
    const id = insertReceived(context, ownerId);
    const rejected = insertRejected(context, ownerId);

    await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", other).expect(404);
    await request(context.app).delete(`/api/documents/${rejected}`).set(SAME_ORIGIN).set("Cookie", other).expect(404);
    await request(context.app).delete("/api/documents/not-a-uuid").set(SAME_ORIGIN).set("Cookie", other).expect(404);
    await request(context.app).delete(`/api/documents/${id}`).set("Sec-Fetch-Site", "cross-site").set("Cookie", owner).expect(403);
    assert.equal(context.s3.commandCalls(DeleteObjectCommand).length, 0);
    assert.ok(context.table.find(`USER#${ownerId}`, `DOC#${id}`));
    assert.ok(context.table.find(`USER#${ownerId}`, `DOC#${rejected}`));
  });
});
