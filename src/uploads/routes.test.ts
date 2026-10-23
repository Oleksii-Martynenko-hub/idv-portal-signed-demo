import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  type GetCommandInput,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import request from "supertest";
import { SignerCredentials } from "../storage/signer-credentials.js";
import {
  completeUpload,
  createTestApp,
  currentUserId,
  discardUpload,
  HTML_BYTES,
  JPEG_BYTES,
  PNG_BYTES,
  requestUpload,
  SAME_ORIGIN,
  sha256Base64,
  STAGED_ETAG,
  stageObject,
  signIn,
  type StagedObject,
  type TestApp,
  type UploadOptions,
} from "../test-support.js";

const MINUTE = 60 * 1000;

function statusError(status: number, name = "Unknown") {
  return new S3ServiceException({ name, $fault: "client", $metadata: { httpStatusCode: status }, message: name });
}

// Signs in, asks for an upload URL and returns what the tests need about it.
async function startUpload(context: TestApp, bytes: Buffer = PNG_BYTES, options: UploadOptions = {}) {
  const cookie = await signIn(context.app, "maria@example.com");
  const userId = await currentUserId(context.app, cookie);
  const response = await requestUpload(context, cookie, bytes, options);
  assert.equal(response.status, 201, response.text);
  const uploadId = response.body.upload.id as string;
  const pending = () => context.table.find(`USER#${userId}`, `UPLOAD#${uploadId}`);
  return { cookie, userId, uploadId, response, pending };
}

function insertDocuments(context: TestApp, userId: string, count: number) {
  for (let n = 0; n < count; n += 1) {
    context.table.insert({
      PK: `USER#${userId}`,
      SK: `DOC#doc-${n}`,
      documentId: `doc-${n}`,
      userId,
      kind: "passport",
      fileName: "passport.png",
      contentType: "image/png",
      size: 10,
      s3Key: `files/users/${userId}/doc-${n}`,
      status: "received",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
}

function deletedKeys(context: TestApp): string[] {
  return context.s3.commandCalls(DeleteObjectCommand).map((call) => String(call.args[0].input.Key));
}

describe("POST /api/uploads", () => {
  it("requires a session", async () => {
    const context = createTestApp();
    const response = await request(context.app).post("/api/uploads").set(SAME_ORIGIN).send({ kind: "passport" });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("signs a PUT into the account's staging area and records the pending upload", async () => {
    const context = createTestApp();
    const before = Date.now();
    const { userId, uploadId, response, pending } = await startUpload(context, PNG_BYTES, { fileName: "Паспорт.png" });

    const { upload } = response.body;
    assert.match(uploadId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(upload).sort(), ["expiresAt", "headers", "id", "method", "url"]);
    assert.equal(upload.method, "PUT");
    assert.deepEqual(upload.headers, {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "attachment",
      "If-None-Match": "*",
      "x-amz-checksum-sha256": sha256Base64(PNG_BYTES),
    });
    const url = new URL(upload.url);
    assert.equal(url.origin, context.config.s3PublicOrigin);
    assert.equal(url.pathname, `/staging/users/${userId}/${uploadId}`);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
    const expiresAt = Date.parse(upload.expiresAt);
    assert.ok(expiresAt > before + 298 * 1000 && expiresAt <= Date.now() + 300 * 1000);

    assert.deepEqual(pending(), {
      PK: `USER#${userId}`,
      SK: `UPLOAD#${uploadId}`,
      documentId: uploadId,
      userId,
      kind: "passport",
      fileName: "Паспорт.png",
      contentType: "image/png",
      size: PNG_BYTES.length,
      stagingKey: `staging/users/${userId}/${uploadId}`,
      checksumSha256: sha256Base64(PNG_BYTES),
      status: "pending",
      createdAt: pending()?.createdAt,
      expiresAt: upload.expiresAt,
      ttl: Math.floor(expiresAt / 1000) + 24 * 60 * 60,
    });
    // Nothing touches S3 until the browser has uploaded.
    assert.equal(context.s3.calls().length, 0);
  });

  it("never builds the key from what the client sends", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);

    const response = await request(context.app)
      .post("/api/uploads")
      .set(SAME_ORIGIN)
      .set("Cookie", cookie)
      .send({
        kind: "passport",
        fileName: "../../files/users/someone-else/x",
        size: PNG_BYTES.length,
        contentType: "image/png",
        checksumSha256: sha256Base64(PNG_BYTES),
        key: "files/users/someone-else/x",
        id: "00000000-0000-4000-8000-000000000000",
        userId: "someone-else",
      });

    assert.equal(response.status, 201, response.text);
    const { id, url } = response.body.upload;
    assert.notEqual(id, "00000000-0000-4000-8000-000000000000");
    assert.equal(new URL(url).pathname, `/staging/users/${userId}/${id}`);
    const stored = context.table.find(`USER#${userId}`, `UPLOAD#${id}`);
    assert.equal(stored?.fileName, "x");
    assert.equal(stored?.stagingKey, `staging/users/${userId}/${id}`);
    assert.equal(context.table.withPrefix("USER#someone-else", "").length, 0);
  });

  it("validates the request before signing anything", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    const valid = {
      kind: "passport",
      fileName: "passport.png",
      size: PNG_BYTES.length,
      contentType: "image/png",
      checksumSha256: sha256Base64(PNG_BYTES),
    };
    const send = (body: unknown) =>
      request(context.app).post("/api/uploads").set(SAME_ORIGIN).set("Cookie", cookie).send(body as object);

    const cases: Array<[unknown, number, string]> = [
      [{ ...valid, kind: "visa" }, 400, "invalid_kind"],
      [{ ...valid, kind: undefined }, 400, "invalid_kind"],
      [{ ...valid, size: 0 }, 400, "empty_file"],
      [{ ...valid, size: -1 }, 400, "invalid_upload"],
      [{ ...valid, size: 1.5 }, 400, "invalid_upload"],
      [{ ...valid, size: "68" }, 400, "invalid_upload"],
      [{ ...valid, size: undefined }, 400, "invalid_upload"],
      [{ ...valid, size: 10 * 1024 * 1024 + 1 }, 413, "file_too_large"],
      [{ ...valid, contentType: "image/gif" }, 415, "unsupported_file_type"],
      [{ ...valid, contentType: "text/html" }, 415, "unsupported_file_type"],
      [{ ...valid, contentType: undefined }, 415, "unsupported_file_type"],
      [{ ...valid, fileName: 42 }, 400, "invalid_upload"],
      [{ ...valid, fileName: undefined }, 400, "invalid_upload"],
      [{ ...valid, fileName: "x".repeat(1025) }, 400, "invalid_upload"],
      [{ ...valid, checksumSha256: undefined }, 400, "invalid_upload"],
      [{ ...valid, checksumSha256: "not-a-checksum" }, 400, "invalid_upload"],
      [{ ...valid, checksumSha256: Buffer.alloc(20).toString("base64") }, 400, "invalid_upload"],
      [[valid], 400, "invalid_upload"],
    ];
    for (const [body, status, code] of cases) {
      const response = await send(body);
      assert.equal(response.status, status, `${JSON.stringify(body).slice(0, 120)}: ${response.text}`);
      assert.equal(response.body.error.code, code);
    }

    const tooLarge = await send({ ...valid, size: 10 * 1024 * 1024 + 1 });
    assert.equal(tooLarge.body.error.message, "Files must be 10 MB or smaller.");
    const notJson = await request(context.app)
      .post("/api/uploads")
      .set(SAME_ORIGIN)
      .set("Cookie", cookie)
      .type("form")
      .send("kind=passport");
    assert.equal(notJson.status, 400);
    assert.equal(notJson.body.error.code, "invalid_upload");

    assert.equal(context.table.withPrefix(`USER#${userId}`, "UPLOAD#").length, 0);
    assert.equal((await send({ ...valid, fileName: "x".repeat(1024) })).status, 201);
  });

  it("caps documents and open uploads together", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    insertDocuments(context, userId, 19);
    const open = await requestUpload(context, cookie, PNG_BYTES);
    assert.equal(open.status, 201);

    const capped = await requestUpload(context, cookie, PNG_BYTES);
    assert.equal(capped.status, 409);
    assert.deepEqual(capped.body, {
      error: { code: "document_limit_reached", message: "You can keep up to 20 documents. Delete one to upload another." },
    });

    // Past URL expiry but inside the completion grace, it still holds a place.
    const stale = context.table.find(`USER#${userId}`, `UPLOAD#${open.body.upload.id}`);
    assert.ok(stale);
    stale.expiresAt = new Date(Date.now() - 5 * MINUTE).toISOString();
    const graced = await requestUpload(context, cookie, PNG_BYTES);
    assert.equal(graced.status, 409);
    assert.equal(graced.body.error.code, "document_limit_reached");

    // An upload past its completion deadline no longer holds a place.
    stale.expiresAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    assert.equal((await requestUpload(context, cookie, PNG_BYTES)).status, 201);
  });

  it("clears expired uploads and what they left in S3 before counting", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context);
    insertDocuments(context, userId, 19);
    const record = pending();
    assert.ok(record);
    record.expiresAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    context.s3.on(DeleteObjectCommand).resolves({});

    const next = await requestUpload(context, cookie, PNG_BYTES);

    assert.equal(next.status, 201, next.text);
    assert.equal(pending(), undefined);
    assert.deepEqual(deletedKeys(context).sort(), [`files/users/${userId}/${uploadId}`, `staging/users/${userId}/${uploadId}`]);
    assert.deepEqual(
      context.table.withPrefix(`USER#${userId}`, "UPLOAD#").map((item) => item.documentId),
      [next.body.upload.id],
    );
  });

  it("answers the request even when expired uploads cannot be cleared", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context);
    const record = pending();
    assert.ok(record);
    record.expiresAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    context.s3.on(DeleteObjectCommand).rejects(new Error("access denied"));

    assert.equal((await requestUpload(context, cookie, PNG_BYTES)).status, 201);
    assert.equal(pending(), undefined);
    assert.deepEqual(deletedKeys(context).sort(), [`files/users/${userId}/${uploadId}`, `staging/users/${userId}/${uploadId}`]);

    const again = await startUpload(context);
    const expired = again.pending();
    assert.ok(expired);
    expired.expiresAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    context.dynamodb.on(DeleteCommand).rejects(new Error("throttled"));
    context.s3.resetHistory();

    assert.equal((await requestUpload(context, again.cookie, PNG_BYTES)).status, 201);
    assert.ok(again.pending());
    assert.deepEqual(deletedKeys(context), []);
  });

  it("counts rejected documents towards the cap", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    insertDocuments(context, userId, 19);
    context.table.insert({
      PK: `USER#${userId}`,
      SK: "DOC#rejected",
      documentId: "rejected",
      userId,
      kind: "passport",
      fileName: "passport.png",
      contentType: "image/png",
      size: 10,
      status: "rejected",
      rejectionCode: "unsupported_file_type",
      rejectionReason: "The file is not a JPEG, PNG or WebP image.",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal((await requestUpload(context, cookie, PNG_BYTES)).status, 409);
  });

  it("is rate limited per account", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await requestUpload(context, cookie, PNG_BYTES);
      assert.equal(response.status, 201, `attempt ${attempt}: ${response.text}`);
      // Keeps the account under its document cap.
      context.table.remove(`USER#${userId}`, `UPLOAD#${response.body.upload.id}`);
    }

    const limited = await requestUpload(context, cookie, PNG_BYTES);
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: { code: "too_many_requests", message: "Too many uploads. Try again later." } });

    const other = await signIn(context.app, "other@example.com");
    assert.equal((await requestUpload(context, other, PNG_BYTES)).status, 201);
  });

  it("rejects cross-site requests", async () => {
    const context = createTestApp();
    const cookie = await signIn(context.app, "maria@example.com");
    const response = await request(context.app)
      .post("/api/uploads")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Cookie", cookie)
      .send({ kind: "passport", fileName: "p.png", size: 68, contentType: "image/png", checksumSha256: sha256Base64(PNG_BYTES) });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "cross_site_request");
  });

  it("answers 502 when the URL cannot be signed and records nothing", async () => {
    const context = createTestApp(
      {},
      {
        signerCredentials: new SignerCredentials(async () => {
          throw new Error("AssumeRole failed");
        }),
      },
    );
    const cookie = await signIn(context.app, "maria@example.com");
    const userId = await currentUserId(context.app, cookie);

    const response = await requestUpload(context, cookie, PNG_BYTES);

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, {
      error: { code: "storage_unavailable", message: "File storage is temporarily unavailable. Try again later." },
    });
    assert.equal(context.table.withPrefix(`USER#${userId}`, "UPLOAD#").length, 0);
  });
});

describe("POST /api/uploads/:id/complete", () => {
  it("checks the staged object, promotes it and records the document", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context, PNG_BYTES, { fileName: "Паспорт.png" });
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 201, response.text);
    const { document } = response.body;
    assert.equal(document.id, uploadId);
    assert.equal(document.kind, "passport");
    assert.equal(document.fileName, "Паспорт.png");
    assert.equal(document.contentType, "image/png");
    assert.equal(document.size, PNG_BYTES.length);
    assert.equal(document.status, "received");
    assert.ok(Date.parse(document.createdAt));
    assert.equal(new URL(document.url).pathname, `/files/users/${userId}/${uploadId}`);
    assert.ok(Date.parse(document.urlExpiresAt) > Date.now());

    const stagingKey = `staging/users/${userId}/${uploadId}`;
    const fileKey = `files/users/${userId}/${uploadId}`;
    assert.deepEqual(context.s3.commandCalls(HeadObjectCommand)[0]?.args[0].input, {
      Bucket: context.config.s3Bucket,
      Key: stagingKey,
      ChecksumMode: "ENABLED",
    });
    assert.deepEqual(context.s3.commandCalls(GetObjectCommand)[0]?.args[0].input, {
      Bucket: context.config.s3Bucket,
      Key: stagingKey,
      Range: `bytes=0-${PNG_BYTES.length - 1}`,
      IfMatch: STAGED_ETAG,
    });
    assert.deepEqual(context.s3.commandCalls(CopyObjectCommand)[0]?.args[0].input, {
      Bucket: context.config.s3Bucket,
      Key: fileKey,
      CopySource: `${context.config.s3Bucket}/${stagingKey}`,
      CopySourceIfMatch: STAGED_ETAG,
      MetadataDirective: "REPLACE",
      ContentType: "image/png",
      CacheControl: "private, no-store",
      ContentDisposition: `inline; filename="_______.png"; filename*=UTF-8''%D0%9F%D0%B0%D1%81%D0%BF%D0%BE%D1%80%D1%82.png`,
      ChecksumAlgorithm: "SHA256",
    });

    // The staged copy goes only once the promoted one is in place.
    const calls = context.s3.calls().map((call) => call.args[0]);
    const copyAt = calls.findIndex((command) => command instanceof CopyObjectCommand);
    const deleteAt = calls.findIndex((command) => command instanceof DeleteObjectCommand);
    assert.ok(copyAt >= 0 && deleteAt > copyAt);
    assert.deepEqual(deletedKeys(context), [stagingKey]);

    assert.equal(pending(), undefined);
    const stored = context.table.find(`USER#${userId}`, `DOC#${uploadId}`);
    assert.equal(stored?.status, "received");
    assert.equal(stored?.s3Key, fileKey);
    assert.equal(stored?.contentType, "image/png");

    const list = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);
    assert.equal(list.body.documents.length, 1);
    assert.equal(list.body.documents[0].id, uploadId);
  });

  it("records the type found in the bytes", async () => {
    const context = createTestApp();
    const { cookie, uploadId } = await startUpload(context, JPEG_BYTES, { contentType: "image/png" });
    stageObject(context, { bytes: JPEG_BYTES, contentType: "image/png" });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.document.contentType, "image/jpeg");
    assert.equal(context.s3.commandCalls(CopyObjectCommand)[0]?.args[0].input.ContentType, "image/jpeg");
  });

  it("reads only the first 4100 bytes of a larger file", async () => {
    const context = createTestApp();
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5000)]);
    const { cookie, uploadId } = await startUpload(context, big);
    stageObject(context, { bytes: big, contentType: "image/png" });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.document.size, big.length);
    assert.equal(context.s3.commandCalls(GetObjectCommand)[0]?.args[0].input.Range, "bytes=0-4099");
  });

  it("accepts a file name with an unpaired surrogate", async () => {
    const context = createTestApp();
    const { cookie, uploadId } = await startUpload(context, PNG_BYTES, { fileName: "scan\ud800.png" });
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.document.fileName, "scan\ufffd.png");
  });

  it("rejects HTML sent as a PNG, removes it and keeps a rejected entry", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context, HTML_BYTES, { fileName: "passport.png" });
    stageObject(context, { bytes: HTML_BYTES, contentType: "image/png" });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 422);
    assert.deepEqual(response.body, {
      error: { code: "unsupported_file_type", message: "The file is not a JPEG, PNG or WebP image." },
    });
    assert.equal(context.s3.commandCalls(CopyObjectCommand).length, 0);
    assert.deepEqual(deletedKeys(context), [`staging/users/${userId}/${uploadId}`]);
    assert.equal(pending(), undefined);

    const list = await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);
    assert.deepEqual(list.body.documents, [
      {
        id: uploadId,
        kind: "passport",
        fileName: "passport.png",
        contentType: "image/png",
        size: HTML_BYTES.length,
        status: "rejected",
        createdAt: list.body.documents[0].createdAt,
        rejectionReason: "The file is not a JPEG, PNG or WebP image.",
      },
    ]);
    const stored = context.table.find(`USER#${userId}`, `DOC#${uploadId}`);
    assert.equal(stored?.rejectionCode, "unsupported_file_type");
    assert.equal("s3Key" in (stored ?? {}), false);
  });

  it("rejects objects that differ from what was declared", async () => {
    const cases: Array<[string, StagedObject["head"], string]> = [
      ["size", { ContentLength: PNG_BYTES.length + 1 }, "size_mismatch"],
      ["type", { ContentType: "image/webp" }, "type_mismatch"],
      ["checksum", { ChecksumSHA256: sha256Base64(HTML_BYTES) }, "checksum_mismatch"],
      ["missing checksum", { ChecksumSHA256: undefined }, "checksum_mismatch"],
      ["content encoding", { ContentEncoding: "gzip" }, "unexpected_metadata"],
      ["content language", { ContentLanguage: "en" }, "unexpected_metadata"],
      ["expires", { ExpiresString: "Wed, 21 Oct 2026 07:28:00 GMT" }, "unexpected_metadata"],
      ["redirect", { WebsiteRedirectLocation: "https://example.com/" }, "unexpected_metadata"],
      ["user metadata", { Metadata: { note: "hello" } }, "unexpected_metadata"],
      ["cache control", { CacheControl: "public, max-age=31536000" }, "unexpected_metadata"],
      ["disposition", { ContentDisposition: "inline" }, "unexpected_metadata"],
    ];
    for (const [label, head, code] of cases) {
      const context = createTestApp();
      const { cookie, userId, uploadId } = await startUpload(context);
      stageObject(context, { bytes: PNG_BYTES, contentType: "image/png", head });

      const response = await completeUpload(context, cookie, uploadId);

      assert.equal(response.status, 422, `${label}: ${response.text}`);
      assert.equal(response.body.error.code, code, label);
      assert.equal(context.s3.commandCalls(GetObjectCommand).length, 0, label);
      assert.equal(context.s3.commandCalls(CopyObjectCommand).length, 0, label);
      assert.deepEqual(deletedKeys(context), [`staging/users/${userId}/${uploadId}`], label);
      assert.equal(context.table.find(`USER#${userId}`, `DOC#${uploadId}`)?.rejectionCode, code, label);
    }
  });

  it("keeps the staged object and the upload when a rejection cannot be recorded", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context, HTML_BYTES);
    stageObject(context, { bytes: HTML_BYTES, contentType: "image/png" });
    context.dynamodb.on(TransactWriteCommand).rejects(new Error("throttled"));

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 500);
    assert.deepEqual(deletedKeys(context), []);
    assert.equal(pending()?.status, "pending");
    assert.equal(context.table.find(`USER#${userId}`, `DOC#${uploadId}`), undefined);
  });

  it("answers 409 and keeps the upload open while nothing has arrived", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);
    // Without s3:ListBucket, S3 answers 403 for a key that does not exist.
    context.s3.on(HeadObjectCommand).rejects(statusError(403));

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: { code: "upload_not_received", message: "The file has not been uploaded yet." },
    });
    assert.equal(pending()?.status, "pending");

    context.s3.reset();
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    assert.equal((await completeUpload(context, cookie, uploadId)).status, 201);
  });

  it("answers 409 while another request is processing the upload", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    const record = pending();
    assert.ok(record);
    record.status = "verifying";

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: { code: "upload_in_progress", message: "This upload is already being processed." },
    });
    assert.equal(context.s3.calls().length, 0);
  });

  it("lets only one of two simultaneous completions through", async () => {
    const context = createTestApp();
    const { cookie, uploadId } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    // The first completion waits inside its HEAD until the second has been answered.
    let reachedHead = () => {};
    const headReached = new Promise<void>((resolve) => {
      reachedHead = resolve;
    });
    let releaseHead = () => {};
    const headReleased = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    context.s3.on(HeadObjectCommand).callsFake(async () => {
      reachedHead();
      await headReleased;
      return {
        ContentLength: PNG_BYTES.length,
        ContentType: "image/png",
        ETag: STAGED_ETAG,
        CacheControl: "private, no-store",
        ContentDisposition: "attachment",
        ChecksumSHA256: sha256Base64(PNG_BYTES),
      };
    });

    const first = completeUpload(context, cookie, uploadId).then((response) => response);
    await headReached;
    const second = await completeUpload(context, cookie, uploadId);
    releaseHead();

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "upload_in_progress");
    assert.equal((await first).status, 201);
    assert.equal(context.s3.commandCalls(CopyObjectCommand).length, 1);
    assert.equal((await completeUpload(context, cookie, uploadId)).status, 404);
  });

  it("answers 410 for an upload past its deadline and cleans it up", async () => {
    for (const status of ["pending", "verifying"]) {
      const context = createTestApp();
      const { cookie, userId, uploadId, pending } = await startUpload(context);
      stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
      const record = pending();
      assert.ok(record);
      record.status = status;
      record.expiresAt = new Date(Date.now() - 11 * MINUTE).toISOString();

      const response = await completeUpload(context, cookie, uploadId);

      assert.equal(response.status, 410, status);
      assert.deepEqual(response.body, {
        error: { code: "upload_expired", message: "This upload has expired. Upload the file again." },
      });
      // A completion that failed late may have left its copy in files/.
      assert.deepEqual(
        deletedKeys(context).sort(),
        [`files/users/${userId}/${uploadId}`, `staging/users/${userId}/${uploadId}`],
        status,
      );
      assert.equal(context.s3.commandCalls(HeadObjectCommand).length, 0, status);
      assert.equal(pending(), undefined, status);
    }
  });

  it("leaves the file alone when a completion finished just before the expired one", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    const record = pending();
    assert.ok(record);
    record.expiresAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    // The other completion replaces the upload with its document right after this request has read it.
    context.dynamodb.on(GetCommand).callsFake((input: GetCommandInput) => {
      const item = context.table.find(String(input.Key?.PK), String(input.Key?.SK));
      if (item && String(input.Key?.SK).startsWith("UPLOAD#")) {
        context.table.remove(`USER#${userId}`, `UPLOAD#${uploadId}`);
        context.table.insert({ ...item, SK: `DOC#${uploadId}`, status: "received", s3Key: `files/users/${userId}/${uploadId}` });
      }
      return { Item: item };
    });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 410);
    assert.deepEqual(deletedKeys(context), []);
    assert.ok(context.table.find(`USER#${userId}`, `DOC#${uploadId}`));
  });

  it("still accepts a completion shortly after the URL expired", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    const record = pending();
    assert.ok(record);
    record.expiresAt = new Date(Date.now() - 9 * MINUTE).toISOString();

    assert.equal((await completeUpload(context, cookie, uploadId)).status, 201);
  });

  it("answers 502 and releases the claim when storage fails", async () => {
    const failures: Array<[string, (context: TestApp) => void]> = [
      ["head", (context) => context.s3.on(HeadObjectCommand).rejects(statusError(500, "InternalError"))],
      ["read", (context) => context.s3.on(GetObjectCommand).rejects(new Error("socket hang up"))],
      ["copy", (context) => context.s3.on(CopyObjectCommand).rejects(statusError(503, "SlowDown"))],
    ];
    for (const [label, fail] of failures) {
      const context = createTestApp();
      const { cookie, userId, uploadId, pending } = await startUpload(context);
      stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
      fail(context);

      const response = await completeUpload(context, cookie, uploadId);

      assert.equal(response.status, 502, `${label}: ${response.text}`);
      assert.equal(response.body.error.code, "storage_unavailable", label);
      assert.equal(pending()?.status, "pending", label);
      assert.equal(context.table.find(`USER#${userId}`, `DOC#${uploadId}`), undefined, label);
      // The copy may have landed even though its answer was an error.
      assert.deepEqual(deletedKeys(context), label === "copy" ? [`files/users/${userId}/${uploadId}`] : [], label);
    }
  });

  it("rejects an object that changed between the checks", async () => {
    const changes: Array<[string, (context: TestApp) => void]> = [
      ["read", (context) => context.s3.on(GetObjectCommand).rejects(statusError(412, "PreconditionFailed"))],
      ["copy", (context) => context.s3.on(CopyObjectCommand).rejects(statusError(412, "PreconditionFailed"))],
    ];
    for (const [label, change] of changes) {
      const context = createTestApp();
      const { cookie, userId, uploadId, pending } = await startUpload(context);
      stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
      change(context);

      const response = await completeUpload(context, cookie, uploadId);

      assert.equal(response.status, 422, `${label}: ${response.text}`);
      assert.deepEqual(response.body, {
        error: { code: "object_changed", message: "The file changed while it was being checked. Upload it again." },
      });
      assert.equal(pending(), undefined, label);
      assert.equal(context.table.find(`USER#${userId}`, `DOC#${uploadId}`)?.status, "rejected", label);
      assert.deepEqual(deletedKeys(context), [`staging/users/${userId}/${uploadId}`], label);
    }
  });

  it("removes the promoted object when the copy's checksum differs", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId } = await startUpload(context);
    stageObject(context, {
      bytes: PNG_BYTES,
      contentType: "image/png",
      copy: { CopyObjectResult: { ChecksumSHA256: sha256Base64(HTML_BYTES) } },
    });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "object_changed");
    assert.deepEqual(deletedKeys(context).sort(), [`files/users/${userId}/${uploadId}`, `staging/users/${userId}/${uploadId}`]);
  });

  it("removes the promoted object before giving the claim back when the records were not written", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    context.dynamodb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ $metadata: {}, message: "Transaction cancelled" }),
    );
    let statusWhileDeleting: string | undefined;
    context.s3.on(DeleteObjectCommand).callsFake(() => {
      statusWhileDeleting = String(pending()?.status);
      return {};
    });

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "internal_error");
    assert.deepEqual(deletedKeys(context), [`files/users/${userId}/${uploadId}`]);
    assert.equal(statusWhileDeleting, "verifying");
    assert.equal(context.table.find(`USER#${userId}`, `DOC#${uploadId}`), undefined);
    assert.equal(pending()?.status, "pending");
  });

  it("keeps the promoted object when the record write may have gone through", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    context.dynamodb.on(TransactWriteCommand).rejects(new Error("socket hang up"));

    const response = await completeUpload(context, cookie, uploadId);

    assert.equal(response.status, 500);
    assert.deepEqual(deletedKeys(context), []);
    assert.equal(pending()?.status, "pending");
  });

  it("reads upload and document records with strong consistency", async () => {
    const context = createTestApp();
    const { cookie, uploadId } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });

    await completeUpload(context, cookie, uploadId).expect(201);
    await request(context.app).get("/api/documents").set("Cookie", cookie).expect(200);

    const reads = [
      ...context.dynamodb
        .commandCalls(GetCommand)
        .map(({ args: [{ input }] }) => ({ sortKey: input.Key?.SK, consistent: input.ConsistentRead })),
      ...context.dynamodb
        .commandCalls(QueryCommand)
        .map(({ args: [{ input }] }) => ({ sortKey: input.ExpressionAttributeValues?.[":prefix"], consistent: input.ConsistentRead })),
    ].filter(({ sortKey }) => /^(UPLOAD|DOC)#/.test(String(sortKey)));
    assert.ok(reads.length >= 3);
    assert.ok(reads.every(({ consistent }) => consistent === true));
  });

  it("does not reveal uploads of other users", async () => {
    const context = createTestApp();
    const { uploadId, pending } = await startUpload(context);
    stageObject(context, { bytes: PNG_BYTES, contentType: "image/png" });
    const other = await signIn(context.app, "other@example.com");

    const response = await completeUpload(context, other, uploadId);

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: { code: "not_found", message: "Not found." } });
    assert.equal(context.s3.calls().length, 0);
    assert.equal(pending()?.status, "pending");
    assert.equal((await completeUpload(context, other, "not-a-uuid")).status, 404);
    assert.equal((await completeUpload(context, other, "00000000-0000-4000-8000-000000000000")).status, 404);
  });

  it("requires a session and a same-origin request", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);

    await request(context.app).post(`/api/uploads/${uploadId}/complete`).set(SAME_ORIGIN).expect(401);
    const crossSite = await request(context.app)
      .post(`/api/uploads/${uploadId}/complete`)
      .set("Sec-Fetch-Site", "cross-site")
      .set("Cookie", cookie);
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error.code, "cross_site_request");
    assert.equal(pending()?.status, "pending");
  });
});

describe("DELETE /api/uploads/:id", () => {
  it("removes a pending upload, its staged object and any copy a failed completion left", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId, pending } = await startUpload(context);
    context.s3.on(DeleteObjectCommand).resolves({});

    const response = await discardUpload(context, cookie, uploadId);

    assert.equal(response.status, 204);
    assert.equal(pending(), undefined);
    assert.deepEqual(
      context.s3.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input),
      [
        { Bucket: context.config.s3Bucket, Key: `staging/users/${userId}/${uploadId}` },
        { Bucket: context.config.s3Bucket, Key: `files/users/${userId}/${uploadId}` },
      ],
    );
    assert.equal((await completeUpload(context, cookie, uploadId)).status, 404);
  });

  it("gives the place in the cap back", async () => {
    const context = createTestApp();
    const { cookie, userId, uploadId } = await startUpload(context);
    insertDocuments(context, userId, 19);
    assert.equal((await requestUpload(context, cookie, PNG_BYTES)).status, 409);

    assert.equal((await discardUpload(context, cookie, uploadId)).status, 204);

    assert.equal((await requestUpload(context, cookie, PNG_BYTES)).status, 201);
  });

  it("answers 409 while a completion is processing the upload", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);
    const record = pending();
    assert.ok(record);
    record.status = "verifying";

    const response = await discardUpload(context, cookie, uploadId);

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: { code: "upload_in_progress", message: "This upload is already being processed." },
    });
    assert.equal(pending()?.status, "verifying");
    assert.equal(context.s3.calls().length, 0);
  });

  it("answers 409 when a completion claims the upload first", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);
    // The claim lands right after this request has read the record.
    context.dynamodb.on(GetCommand).callsFake((input: GetCommandInput) => {
      const item = context.table.find(String(input.Key?.PK), String(input.Key?.SK));
      if (item && String(input.Key?.SK).startsWith("UPLOAD#")) {
        context.table.insert({ ...item, status: "verifying" });
      }
      return { Item: item };
    });

    const response = await discardUpload(context, cookie, uploadId);

    assert.equal(response.status, 409);
    assert.equal(pending()?.status, "verifying");
    assert.equal(context.s3.calls().length, 0);
  });

  it("does not reveal uploads of other users", async () => {
    const context = createTestApp();
    const { uploadId, pending } = await startUpload(context);
    const other = await signIn(context.app, "other@example.com");

    const response = await discardUpload(context, other, uploadId);

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: { code: "not_found", message: "Not found." } });
    assert.equal(pending()?.status, "pending");
    assert.equal((await discardUpload(context, other, "not-a-uuid")).status, 404);
    assert.equal(context.s3.calls().length, 0);
  });

  it("requires a session and a same-origin request", async () => {
    const context = createTestApp();
    const { cookie, uploadId, pending } = await startUpload(context);

    await request(context.app).delete(`/api/uploads/${uploadId}`).set(SAME_ORIGIN).expect(401);
    const crossSite = await request(context.app)
      .delete(`/api/uploads/${uploadId}`)
      .set("Sec-Fetch-Site", "cross-site")
      .set("Cookie", cookie);
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error.code, "cross_site_request");
    assert.equal(pending()?.status, "pending");
  });
});
