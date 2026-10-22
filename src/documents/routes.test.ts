import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import request from "supertest";
import {
  createTestApp,
  currentUserId,
  failingObjectBody,
  HTML_BYTES,
  objectBody,
  PNG_BYTES,
  SAME_ORIGIN,
  signIn,
  type TestApp,
} from "../test-support.js";

const KIND_PASSPORT = "passport";

function upload(context: TestApp, cookie: string, bytes: Buffer, options: { kind?: string; filename?: string; contentType?: string } = {}) {
  return request(context.app)
    .post("/api/documents")
    .set(SAME_ORIGIN)
    .set("Cookie", cookie)
    .field("kind", options.kind ?? KIND_PASSPORT)
    .attach("file", bytes, { filename: options.filename ?? "passport.png", contentType: options.contentType ?? "image/png" });
}

async function uploadPng(context: TestApp, cookie: string): Promise<string> {
  context.s3.on(PutObjectCommand).resolves({});
  const response = await upload(context, cookie, PNG_BYTES);
  assert.equal(response.status, 201, response.text);
  return response.body.document.id as string;
}

describe("POST /api/documents", () => {
  it("requires a session", async () => {
    const context = createTestApp();
    const response = await request(context.app).post("/api/documents").set(SAME_ORIGIN).field("kind", KIND_PASSPORT);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("stores a valid image and records the document", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    context.s3.on(PutObjectCommand).resolves({});

    const response = await upload(context, cookie, PNG_BYTES, { filename: "Паспорт.png" });

    assert.equal(response.status, 201, response.text);
    const document = response.body.document;
    assert.match(document.id, /^[0-9a-f-]{36}$/);
    assert.equal(document.kind, KIND_PASSPORT);
    assert.equal(document.fileName, "Паспорт.png");
    assert.equal(document.contentType, "image/png");
    assert.equal(document.size, PNG_BYTES.length);
    assert.equal(document.status, "received");
    assert.ok(Date.parse(document.createdAt));
    assert.deepEqual(Object.keys(document).sort(), ["contentType", "createdAt", "fileName", "id", "kind", "size", "status"]);

    const puts = context.s3.commandCalls(PutObjectCommand);
    assert.equal(puts.length, 1);
    const input = puts[0]?.args[0].input;
    assert.equal(input?.Bucket, context.config.s3Bucket);
    assert.equal(input?.Key, `users/${userId}/documents/${document.id}`);
    assert.equal(input?.ContentType, "image/png");
    assert.equal(input?.ContentLength, PNG_BYTES.length);
    assert.equal(input?.IfNoneMatch, "*");
    assert.ok(Buffer.isBuffer(input?.Body) && input.Body.equals(PNG_BYTES));

    const stored = context.table.find(`USER#${userId}`, `DOC#${document.id}`);
    assert.ok(stored);
    assert.equal(stored.s3Key, `users/${userId}/documents/${document.id}`);
    assert.equal(stored.contentType, "image/png");

    const list = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);
    assert.deepEqual(list.body, { documents: [document] });
  });

  it("detects the type from the bytes, not from the declared type", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");

    const response = await upload(context, cookie, HTML_BYTES, { filename: "passport.png", contentType: "image/png" });

    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "unsupported_file_type");
    assert.equal(context.s3.calls().length, 0);
    assert.equal(context.table.withPrefix("USER#", "").filter((item) => String(item.SK).startsWith("DOC#")).length, 0);
  });

  it("rejects a body that cannot fit before reading it", async () => {
    const context = createTestApp({ MAX_UPLOAD_MB: "0.01" });
    const cookie = await signIn(context.app, "maria@example.com");

    const response = await upload(context, cookie, Buffer.concat([PNG_BYTES, Buffer.alloc(100 * 1024)]));

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "file_too_large");
    assert.equal(context.s3.calls().length, 0);
  });

  it("rejects a file over the limit while reading it", async () => {
    const context = createTestApp({ MAX_UPLOAD_MB: "0.01" });
    const cookie = await signIn(context.app, "maria@example.com");

    const response = await upload(context, cookie, Buffer.concat([PNG_BYTES, Buffer.alloc(20 * 1024)]));

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "file_too_large");
    assert.equal(context.s3.calls().length, 0);
  });

  it("requires a Content-Length header", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const server = context.app.listen(0);
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/documents`, {
        method: "POST",
        headers: { ...SAME_ORIGIN, Cookie: cookie, "Content-Type": "multipart/form-data; boundary=x" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("--x--\r\n"));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      assert.equal(response.status, 411);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "length_required");
    } finally {
      server.close();
    }
  });

  it("validates the form", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");

    const empty = await upload(context, cookie, Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, "empty_file");

    const kind = await upload(context, cookie, PNG_BYTES, { kind: "visa" });
    assert.equal(kind.status, 400);
    assert.equal(kind.body.error.code, "invalid_kind");

    const noFile = await request(context.app).post("/api/documents").set(SAME_ORIGIN).set("Cookie", cookie).field("kind", KIND_PASSPORT);
    assert.equal(noFile.status, 400);
    assert.equal(noFile.body.error.code, "bad_upload");

    const extraField = await upload(context, cookie, PNG_BYTES).field("note", "x");
    assert.equal(extraField.status, 400);
    assert.equal(extraField.body.error.code, "bad_upload");

    const notMultipart = await request(context.app).post("/api/documents").set(SAME_ORIGIN).set("Cookie", cookie).send({ kind: KIND_PASSPORT });
    assert.equal(notMultipart.status, 400);
    assert.equal(context.s3.calls().length, 0);
  });

  it("reports storage failures and keeps the record out of the table", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    context.s3.on(PutObjectCommand).rejects(new Error("connection reset"));

    const response = await upload(context, cookie, PNG_BYTES);

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, {
      error: { code: "storage_unavailable", message: "File storage is temporarily unavailable. Try again later." },
    });
    assert.equal(context.table.withPrefix(`USER#${userId}`, "DOC#").length, 0);
  });

  it("removes the object again when the record cannot be written", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    context.s3.on(PutObjectCommand).resolves({});
    context.s3.on(DeleteObjectCommand).resolves({});
    context.dynamodb.on(PutCommand).rejects(new Error("throttled"));

    const response = await upload(context, cookie, PNG_BYTES);

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "internal_error");
    const key = context.s3.commandCalls(PutObjectCommand)[0]?.args[0].input.Key;
    assert.ok(key);
    assert.equal(context.s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input.Key, key);
    assert.equal(context.table.withPrefix(`USER#${userId}`, "DOC#").length, 0);
  });

  it("caps the number of documents per account", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    for (let n = 0; n < 20; n += 1) {
      context.table.insert({
        PK: `USER#${userId}`,
        SK: `DOC#doc-${n}`,
        documentId: `doc-${n}`,
        userId,
        kind: KIND_PASSPORT,
        fileName: "passport.png",
        contentType: "image/png",
        size: 10,
        s3Key: `users/${userId}/documents/doc-${n}`,
        status: "received",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }

    const response = await upload(context, cookie, PNG_BYTES);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "document_limit_reached");
    assert.equal(context.s3.calls().length, 0);
  });

  it("is rate limited per account", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    context.s3.on(DeleteObjectCommand).resolves({});
    // Each document is removed again so the account stays under its document cap.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const id = await uploadPng(context, cookie);
      await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie).expect(204);
    }

    const response = await upload(context, cookie, PNG_BYTES);

    assert.equal(response.status, 429);
    assert.equal(response.body.error.code, "too_many_requests");
    const other = await signIn(context.app, "other@example.com");
    await upload(context, other, PNG_BYTES).expect(201);
  });

  it("answers 503 while the upload budget is in use", async () => {
    const context = createTestApp({ MAX_CONCURRENT_UPLOADS: "1" });
    const cookie = await signIn(context.app, "maria@example.com");
    let release = () => {};
    const stored = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.s3.on(PutObjectCommand).callsFake(() => stored.then(() => ({})));

    const first = upload(context, cookie, PNG_BYTES).then((response) => response);
    while (context.s3.commandCalls(PutObjectCommand).length === 0) {
      await delay(5);
    }
    const second = await upload(context, cookie, PNG_BYTES);
    release();

    assert.equal(second.status, 503);
    assert.equal(second.body.error.code, "server_busy");
    assert.equal(second.headers["retry-after"], "5");
    assert.equal((await first).status, 201);
  });

  it("rejects cross-site uploads", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const response = await request(context.app)
      .post("/api/documents")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Cookie", cookie)
      .field("kind", KIND_PASSPORT)
      .attach("file", PNG_BYTES, "passport.png");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "cross_site_request");
  });
});

describe("GET /api/documents", () => {
  it("lists the caller's documents, newest first", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const base = { PK: `USER#${userId}`, userId, kind: "id_card", fileName: "id.jpg", contentType: "image/jpeg", size: 10, status: "received" };
    context.table.insert({ ...base, SK: "DOC#older", documentId: "older", s3Key: "users/x/documents/older", createdAt: "2026-01-01T00:00:00.000Z" });
    context.table.insert({ ...base, SK: "DOC#newer", documentId: "newer", s3Key: "users/x/documents/newer", createdAt: "2026-02-01T00:00:00.000Z" });
    context.table.insert({ ...base, PK: "USER#someone-else", SK: "DOC#theirs", documentId: "theirs", s3Key: "users/y/documents/theirs", createdAt: "2026-03-01T00:00:00.000Z" });

    const response = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);

    assert.deepEqual(
      response.body.documents.map((document: { id: string }) => document.id),
      ["newer", "older"],
    );
    assert.equal("s3Key" in response.body.documents[0], false);
    assert.equal("userId" in response.body.documents[0], false);
  });

  it("requires a session", async () => {
    const { app } = createTestApp();
    await request(app).get("/api/documents").expect(401);
  });
});

describe("GET /api/documents/:id/file", () => {
  it("streams the stored object with download headers", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = await uploadPng(context, cookie);
    context.s3.on(GetObjectCommand).resolves({ Body: objectBody(PNG_BYTES), ContentType: "image/png", ContentLength: PNG_BYTES.length });

    const response = await request(context.app).get(`/api/documents/${id}/file`).set("Cookie", cookie).buffer(true);

    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["content-length"], String(PNG_BYTES.length));
    assert.equal(response.headers["content-disposition"], `inline; filename="passport.png"; filename*=UTF-8''passport.png`);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.ok(Buffer.isBuffer(response.body) && response.body.equals(PNG_BYTES));
    assert.equal(context.s3.commandCalls(GetObjectCommand)[0]?.args[0].input.Key, `users/${userId}/documents/${id}`);
  });

  it("does not reveal documents of other users", async () => {
    const context = createTestApp();
    const owner = await signIn(context.app, "owner@example.com");
    const other = await signIn(context.app, "other@example.com");
    const id = await uploadPng(context, owner);
    context.s3.on(GetObjectCommand).resolves({ Body: objectBody(PNG_BYTES) });

    const response = await request(context.app).get(`/api/documents/${id}/file`).set("Cookie", other);

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: { code: "not_found", message: "Not found." } });
    assert.equal(context.s3.commandCalls(GetObjectCommand).length, 0);
    await request(context.app).get(`/api/documents/not-a-uuid/file`).set("Cookie", other).expect(404);
    await request(context.app).get(`/api/documents/00000000-0000-4000-8000-000000000000/file`).set("Cookie", owner).expect(404);
  });

  it("answers 404 when the object is missing from storage", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const id = await uploadPng(context, cookie);
    context.s3.on(GetObjectCommand).rejects(new NoSuchKey({ $metadata: {}, message: "The specified key does not exist." }));

    const response = await request(context.app).get(`/api/documents/${id}/file`).set("Cookie", cookie);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not_found");
  });

  it("answers 502 when storage fails", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const id = await uploadPng(context, cookie);
    context.s3.on(GetObjectCommand).rejects(new Error("timeout"));

    const response = await request(context.app).get(`/api/documents/${id}/file`).set("Cookie", cookie);

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "storage_unavailable");
  });

  it("answers 502 as JSON when the object stream fails before the first byte", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const id = await uploadPng(context, cookie);
    context.s3.on(GetObjectCommand).resolves({
      Body: failingObjectBody(new Error("connection reset")),
      ContentType: "image/png",
      ContentLength: PNG_BYTES.length,
    });

    const response = await request(context.app).get(`/api/documents/${id}/file`).set("Cookie", cookie);

    assert.equal(response.status, 502);
    assert.match(response.headers["content-type"] ?? "", /application\/json/);
    assert.equal(response.headers["content-disposition"], undefined);
    assert.equal(response.headers["content-length"], String(Buffer.byteLength(response.text)));
    assert.equal(response.body.error.code, "storage_unavailable");
  });

  it("requires a session", async () => {
    const { app } = createTestApp();
    await request(app).get("/api/documents/00000000-0000-4000-8000-000000000000/file").expect(401);
  });
});

describe("DELETE /api/documents/:id", () => {
  it("removes the object and then the record", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = await uploadPng(context, cookie);
    context.s3.on(DeleteObjectCommand).resolves({});

    await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie).expect(204);

    assert.equal(context.s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input.Key, `users/${userId}/documents/${id}`);
    assert.equal(context.table.find(`USER#${userId}`, `DOC#${id}`), undefined);
    const list = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);
    assert.deepEqual(list.body, { documents: [] });
  });

  it("keeps the record when the object cannot be deleted", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const id = await uploadPng(context, cookie);
    context.s3.on(DeleteObjectCommand).rejects(new Error("access denied"));

    const response = await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", cookie);

    assert.equal(response.status, 502);
    assert.ok(context.table.find(`USER#${userId}`, `DOC#${id}`));
  });

  it("answers 404 for documents of other users and rejects cross-site requests", async () => {
    const context = createTestApp();
    const owner = await signIn(context.app, "owner@example.com");
    const other = await signIn(context.app, "other@example.com");
    const id = await uploadPng(context, owner);

    await request(context.app).delete(`/api/documents/${id}`).set(SAME_ORIGIN).set("Cookie", other).expect(404);
    await request(context.app).delete(`/api/documents/${id}`).set("Sec-Fetch-Site", "cross-site").set("Cookie", owner).expect(403);
    assert.equal(context.s3.commandCalls(DeleteObjectCommand).length, 0);
  });
});
