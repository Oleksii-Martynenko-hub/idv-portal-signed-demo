import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { objectBody, PNG_BYTES } from "../test-support.js";
import { ObjectChangedError, ObjectStore } from "./s3.js";

const BUCKET = "idv-documents-test";

function storeWithMock() {
  const client = new S3Client({ region: "eu-west-1" });
  const s3 = mockClient(client);
  return { s3, store: new ObjectStore(client, BUCKET) };
}

function statusError(status: number, name = "Unknown") {
  return new S3ServiceException({ name, $fault: "client", $metadata: { httpStatusCode: status }, message: name });
}

describe("ObjectStore.head", () => {
  it("reports what S3 stored, checksum included", async () => {
    const { s3, store } = storeWithMock();
    s3.on(HeadObjectCommand).resolves({
      ContentLength: 68,
      ContentType: "image/png",
      ETag: '"abc"',
      CacheControl: "private, no-store",
      ContentDisposition: "attachment",
      ContentEncoding: "gzip",
      ContentLanguage: "en",
      ExpiresString: "Wed, 21 Oct 2026 07:28:00 GMT",
      WebsiteRedirectLocation: "/elsewhere",
      Metadata: { note: "x" },
      ChecksumSHA256: "c2hh",
    });

    const head = await store.head("staging/users/u/d");

    assert.deepEqual(head, {
      size: 68,
      contentType: "image/png",
      eTag: '"abc"',
      cacheControl: "private, no-store",
      contentDisposition: "attachment",
      contentEncoding: "gzip",
      contentLanguage: "en",
      expires: "Wed, 21 Oct 2026 07:28:00 GMT",
      websiteRedirectLocation: "/elsewhere",
      metadata: { note: "x" },
      checksumSha256: "c2hh",
    });
    assert.deepEqual(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input, {
      Bucket: BUCKET,
      Key: "staging/users/u/d",
      ChecksumMode: "ENABLED",
    });
  });

  it("treats 404 and 403 as a missing object", async () => {
    for (const error of [new NotFound({ $metadata: { httpStatusCode: 404 }, message: "NotFound" }), statusError(403)]) {
      const { s3, store } = storeWithMock();
      s3.on(HeadObjectCommand).rejects(error);
      assert.equal(await store.head("staging/users/u/d"), undefined);
    }
  });

  it("passes other failures on", async () => {
    const { s3, store } = storeWithMock();
    s3.on(HeadObjectCommand).rejects(statusError(500, "InternalError"));
    await assert.rejects(store.head("staging/users/u/d"), /InternalError/);
  });
});

describe("ObjectStore.readStart", () => {
  it("reads a range of the version that was checked", async () => {
    const { s3, store } = storeWithMock();
    s3.on(GetObjectCommand).resolves({ Body: objectBody(PNG_BYTES) });

    const bytes = await store.readStart("staging/users/u/d", 16, '"abc"');

    assert.ok(bytes.equals(PNG_BYTES.subarray(0, 16)));
    assert.deepEqual(s3.commandCalls(GetObjectCommand)[0]?.args[0].input, {
      Bucket: BUCKET,
      Key: "staging/users/u/d",
      Range: "bytes=0-15",
      IfMatch: '"abc"',
    });
  });

  it("reports a changed object", async () => {
    const { s3, store } = storeWithMock();
    s3.on(GetObjectCommand).rejects(statusError(412, "PreconditionFailed"));
    await assert.rejects(store.readStart("staging/users/u/d", 16, '"abc"'), ObjectChangedError);
  });
});

describe("ObjectStore.promote", () => {
  const promotion = {
    from: "staging/users/u/d",
    to: "files/users/u/d",
    eTag: '"abc"',
    contentType: "image/png",
    cacheControl: "private, no-store",
    contentDisposition: `inline; filename="passport.png"; filename*=UTF-8''passport.png`,
  };

  it("copies the checked version and replaces its metadata", async () => {
    const { s3, store } = storeWithMock();
    s3.on(CopyObjectCommand).resolves({ CopyObjectResult: { ETag: '"abc"', ChecksumSHA256: "c2hh" } });

    assert.equal(await store.promote(promotion), "c2hh");
    assert.deepEqual(s3.commandCalls(CopyObjectCommand)[0]?.args[0].input, {
      Bucket: BUCKET,
      Key: "files/users/u/d",
      CopySource: `${BUCKET}/staging/users/u/d`,
      CopySourceIfMatch: '"abc"',
      MetadataDirective: "REPLACE",
      ContentType: "image/png",
      CacheControl: "private, no-store",
      ContentDisposition: promotion.contentDisposition,
      ChecksumAlgorithm: "SHA256",
    });
  });

  it("reports a changed source", async () => {
    const { s3, store } = storeWithMock();
    s3.on(CopyObjectCommand).rejects(statusError(412, "PreconditionFailed"));
    await assert.rejects(store.promote(promotion), ObjectChangedError);
  });
});

describe("ObjectStore.delete", () => {
  it("deletes the key", async () => {
    const { s3, store } = storeWithMock();
    s3.on(DeleteObjectCommand).resolves({});
    await store.delete("files/users/u/d");
    assert.deepEqual(s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input, { Bucket: BUCKET, Key: "files/users/u/d" });
  });
});
