import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  CopyObjectCommand,
  type CopyObjectCommandOutput,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  type DeleteCommandInput,
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandInput,
  PutCommand,
  type PutCommandInput,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { type AwsClientStub, mockClient } from "aws-sdk-client-mock";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { UrlSigner } from "./storage/presigner.js";
import { type AwsCredentials, SignerCredentials } from "./storage/signer-credentials.js";
import { STAGING_CACHE_CONTROL, STAGING_CONTENT_DISPOSITION } from "./uploads/inspection.js";

export const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" } as const;

export function testConfig(env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    AWS_REGION: "eu-west-1",
    S3_BUCKET: "idv-documents-test",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ...env,
  });
}

// Static, made-up session credentials; signing needs no network.
export const SIGNER_CREDENTIALS: AwsCredentials = {
  accessKeyId: "ASIATESTSIGNER000001",
  secretAccessKey: "test-signer-secret-access-key",
  sessionToken: "test-signer-session-token",
};

export function testSigner(config: Config, credentials = new SignerCredentials(async () => SIGNER_CREDENTIALS)): UrlSigner {
  return new UrlSigner({
    bucket: config.s3Bucket,
    region: config.awsRegion,
    endpoint: config.s3Endpoint,
    credentials,
  });
}

type Attributes = Record<string, unknown>;

interface Conditional {
  ConditionExpression?: string | undefined;
  ExpressionAttributeNames?: Record<string, string> | undefined;
  ExpressionAttributeValues?: Record<string, unknown> | undefined;
}

function keyOf(key: Attributes | undefined): string {
  return `${String(key?.PK)}|${String(key?.SK)}`;
}

function attributeName(input: Conditional, name: string): string {
  return name.startsWith("#") ? (input.ExpressionAttributeNames?.[name] ?? name) : name;
}

// The condition shapes the repositories use: attribute_not_exists(PK),
// attribute_exists(PK) and "#name = :value", joined by AND.
function conditionHolds(input: Conditional, item: Attributes | undefined): boolean {
  const condition = input.ConditionExpression;
  if (condition === undefined) return true;
  return condition.split(" AND ").every((clause) => clauseHolds(input, clause, item));
}

function clauseHolds(input: Conditional, clause: string, item: Attributes | undefined): boolean {
  if (clause === "attribute_not_exists(PK)") return item === undefined;
  if (clause === "attribute_exists(PK)") return item !== undefined;
  const [, name, value] = /^(#?\w+) = (:\w+)$/.exec(clause) ?? [];
  if (name === undefined || value === undefined) {
    throw new Error(`FakeTable does not understand the condition "${clause}"`);
  }
  return item !== undefined && item[attributeName(input, name)] === input.ExpressionAttributeValues?.[value];
}

function conditionFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ $metadata: {}, message: "The conditional request failed" });
}

// Enough of DynamoDB's single-table behaviour for the repositories to run against.
export class FakeTable {
  readonly items = new Map<string, Attributes>();

  attach(mock: AwsClientStub<DynamoDBDocumentClient>): void {
    mock.on(GetCommand).callsFake((input: GetCommandInput) => ({ Item: this.items.get(keyOf(input.Key)) }));
    mock.on(PutCommand).callsFake((input: PutCommandInput) => {
      this.put(input);
      return {};
    });
    mock.on(UpdateCommand).callsFake((input: UpdateCommandInput) => {
      this.update(input);
      return {};
    });
    mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
      this.delete(input);
      return {};
    });
    mock.on(QueryCommand).callsFake((input: QueryCommandInput) => ({ Items: this.query(input) }));
    mock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      this.transact(input);
      return {};
    });
  }

  find(pk: string, sk: string): Attributes | undefined {
    return this.items.get(keyOf({ PK: pk, SK: sk }));
  }

  insert(item: Attributes): void {
    this.items.set(keyOf(item), item);
  }

  remove(pk: string, sk: string): void {
    this.items.delete(keyOf({ PK: pk, SK: sk }));
  }

  withPrefix(pk: string, skPrefix: string): Attributes[] {
    return [...this.items.values()].filter(
      (item) => item.PK === pk && typeof item.SK === "string" && item.SK.startsWith(skPrefix),
    );
  }

  private put(input: PutCommandInput): void {
    const item = input.Item ?? {};
    if (!conditionHolds(input, this.items.get(keyOf(item)))) throw conditionFailed();
    this.items.set(keyOf(item), item);
  }

  // Supports "SET #a = :x, b = :y".
  private update(input: UpdateCommandInput): void {
    const key = keyOf(input.Key);
    const existing = this.items.get(key);
    if (!conditionHolds(input, existing)) throw conditionFailed();
    const assignments = /^SET (.+)$/.exec(input.UpdateExpression ?? "")?.[1];
    if (assignments === undefined) {
      throw new Error(`FakeTable does not understand the update "${input.UpdateExpression}"`);
    }
    const updated: Attributes = { ...(existing ?? input.Key) };
    for (const assignment of assignments.split(",")) {
      const [name = "", value = ""] = assignment.split("=").map((part) => part.trim());
      updated[attributeName(input, name)] = input.ExpressionAttributeValues?.[value];
    }
    this.items.set(key, updated);
  }

  private delete(input: DeleteCommandInput): void {
    if (!conditionHolds(input, this.items.get(keyOf(input.Key)))) throw conditionFailed();
    this.items.delete(keyOf(input.Key));
  }

  private query(input: QueryCommandInput): Attributes[] {
    const values = input.ExpressionAttributeValues ?? {};
    return this.withPrefix(String(values[":pk"]), String(values[":prefix"]));
  }

  // All conditions are checked before anything is written, as DynamoDB does.
  private transact(input: TransactWriteCommandInput): void {
    const entries = input.TransactItems ?? [];
    const reasons = entries.map((entry) => {
      if (entry.Put) return conditionHolds(entry.Put, this.items.get(keyOf(entry.Put.Item)));
      if (entry.Delete) return conditionHolds(entry.Delete, this.items.get(keyOf(entry.Delete.Key)));
      throw new Error("FakeTable supports Put and Delete in transactions");
    });
    if (reasons.includes(false)) {
      throw new TransactionCanceledException({
        $metadata: {},
        message: "Transaction cancelled",
        CancellationReasons: reasons.map((holds) => ({ Code: holds ? "None" : "ConditionalCheckFailed" })),
      });
    }
    for (const entry of entries) {
      if (entry.Put) this.items.set(keyOf(entry.Put.Item), entry.Put.Item ?? {});
      if (entry.Delete) this.items.delete(keyOf(entry.Delete.Key));
    }
  }
}

export interface TestApp {
  app: Express;
  config: Config;
  s3: AwsClientStub<S3Client>;
  dynamodb: AwsClientStub<DynamoDBDocumentClient>;
  table: FakeTable;
}

export interface TestAppOptions {
  signerCredentials?: SignerCredentials;
}

export function createTestApp(env: NodeJS.ProcessEnv = {}, { signerCredentials }: TestAppOptions = {}): TestApp {
  const config = testConfig(env);
  const s3Client = new S3Client({ region: config.awsRegion });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }));
  const s3 = mockClient(s3Client);
  const dynamodb = mockClient(documentClient);
  const table = new FakeTable();
  table.attach(dynamodb);

  const app = createApp({
    config,
    logger: createLogger(config.logLevel),
    s3: s3Client,
    dynamodb: documentClient,
    signer: testSigner(config, signerCredentials),
  });
  return { app, config, s3, dynamodb, table };
}

// Signs in and returns the Cookie header value for later requests.
export async function signIn(app: Express, email: string): Promise<string> {
  const response = await request(app).post("/auth/sign-in").set(SAME_ORIGIN).send({ email });
  assert.equal(response.status, 204, `sign-in failed: ${response.text}`);
  const cookie = (response.get("Set-Cookie") ?? [])[0]?.split(";")[0];
  assert.ok(cookie, "sign-in did not set a cookie");
  return cookie;
}

export async function currentUserId(app: Express, cookie: string): Promise<string> {
  const response = await request(app).get("/api/me").set("Cookie", cookie);
  assert.equal(response.status, 200);
  return response.body.id as string;
}

// The value the browser sends as checksumSha256 and S3 reports back.
export function sha256Base64(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64");
}

export function objectBody(bytes: Buffer): GetObjectCommandOutput["Body"] {
  const body = Object.assign(Readable.from([bytes]), {
    transformToByteArray: async () => new Uint8Array(bytes),
    transformToString: async () => bytes.toString(),
    transformToWebStream: () => {
      throw new Error("not used");
    },
  });
  return body as unknown as GetObjectCommandOutput["Body"];
}

export const STAGED_ETAG = '"5d41402abc4b2a76b9719d911017c592"';

export interface StagedObject {
  bytes: Buffer;
  contentType: string;
  // Overrides for what HEAD reports, e.g. headers the uploader added.
  head?: Partial<HeadObjectCommandOutput>;
  copy?: Partial<CopyObjectCommandOutput>;
}

// Makes S3 report a staged object as the browser's PUT would leave it. Tests
// can override any of these commands afterwards to make one step fail.
export function stageObject(context: TestApp, { bytes, contentType, head, copy }: StagedObject): void {
  context.s3.on(HeadObjectCommand).resolves({
    ContentLength: bytes.length,
    ContentType: contentType,
    ETag: STAGED_ETAG,
    CacheControl: STAGING_CACHE_CONTROL,
    ContentDisposition: STAGING_CONTENT_DISPOSITION,
    ChecksumSHA256: sha256Base64(bytes),
    ChecksumType: "FULL_OBJECT",
    Metadata: {},
    ...head,
  });
  context.s3.on(GetObjectCommand).callsFake((input: GetObjectCommandInput) => {
    const [, last] = /^bytes=0-(\d+)$/.exec(input.Range ?? "") ?? [];
    const end = last === undefined ? bytes.length : Number(last) + 1;
    return { Body: objectBody(bytes.subarray(0, end)), ETag: STAGED_ETAG };
  });
  context.s3.on(CopyObjectCommand).resolves({
    CopyObjectResult: { ETag: STAGED_ETAG, ChecksumSHA256: sha256Base64(bytes), ChecksumType: "FULL_OBJECT" },
    ...copy,
  });
  context.s3.on(DeleteObjectCommand).resolves({});
}

export interface UploadOptions {
  kind?: string;
  fileName?: string;
  contentType?: string;
}

// POST /api/uploads for these bytes, as the account page sends it.
export function requestUpload(context: TestApp, cookie: string, bytes: Buffer, options: UploadOptions = {}) {
  return request(context.app)
    .post("/api/uploads")
    .set(SAME_ORIGIN)
    .set("Cookie", cookie)
    .send({
      kind: options.kind ?? "passport",
      fileName: options.fileName ?? "passport.png",
      size: bytes.length,
      contentType: options.contentType ?? "image/png",
      checksumSha256: sha256Base64(bytes),
    });
}

export function completeUpload(context: TestApp, cookie: string, uploadId: string) {
  return request(context.app).post(`/api/uploads/${uploadId}/complete`).set(SAME_ORIGIN).set("Cookie", cookie);
}

export function discardUpload(context: TestApp, cookie: string, uploadId: string) {
  return request(context.app).delete(`/api/uploads/${uploadId}`).set(SAME_ORIGIN).set("Cookie", cookie);
}

// The whole flow: sign, "PUT" (the staged object), complete. Returns the document id.
export async function uploadDocument(
  context: TestApp,
  cookie: string,
  bytes: Buffer,
  options: UploadOptions = {},
): Promise<string> {
  const signed = await requestUpload(context, cookie, bytes, options);
  assert.equal(signed.status, 201, signed.text);
  const uploadId = signed.body.upload.id as string;
  stageObject(context, { bytes, contentType: options.contentType ?? "image/png" });
  const completed = await completeUpload(context, cookie, uploadId);
  assert.equal(completed.status, 201, completed.text);
  return completed.body.document.id as string;
}

// 1x1 transparent PNG.
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0"),
  Buffer.alloc(64),
]);
export const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(56),
]);
export const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
export const HTML_BYTES = Buffer.from("<!doctype html>\n<html><body><script>document.title = 1</script></body></html>\n");
export const TEXT_BYTES = Buffer.from("Just a plain text file.\n");
