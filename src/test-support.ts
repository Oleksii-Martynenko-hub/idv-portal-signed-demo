import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { type GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
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
} from "@aws-sdk/lib-dynamodb";
import { type AwsClientStub, mockClient } from "aws-sdk-client-mock";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

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

type Attributes = Record<string, unknown>;

function keyOf(key: Attributes | undefined): string {
  return `${String(key?.PK)}|${String(key?.SK)}`;
}

function conditionFails(condition: string | undefined, exists: boolean): boolean {
  return condition === "attribute_not_exists(PK)" && exists;
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
    mock.on(DeleteCommand).callsFake((input: DeleteCommandInput) => {
      this.items.delete(keyOf(input.Key));
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

  withPrefix(pk: string, skPrefix: string): Attributes[] {
    return [...this.items.values()].filter(
      (item) => item.PK === pk && typeof item.SK === "string" && item.SK.startsWith(skPrefix),
    );
  }

  private put(input: PutCommandInput): void {
    const item = input.Item ?? {};
    const key = keyOf(item);
    if (conditionFails(input.ConditionExpression, this.items.has(key))) {
      throw new ConditionalCheckFailedException({ $metadata: {}, message: "The conditional request failed" });
    }
    this.items.set(key, item);
  }

  private query(input: QueryCommandInput): Attributes[] {
    const values = input.ExpressionAttributeValues ?? {};
    return this.withPrefix(String(values[":pk"]), String(values[":prefix"]));
  }

  private transact(input: TransactWriteCommandInput): void {
    const puts = (input.TransactItems ?? []).flatMap((entry) => (entry.Put ? [entry.Put] : []));
    const failed = puts.some((put) => conditionFails(put.ConditionExpression, this.items.has(keyOf(put.Item))));
    if (failed) {
      throw new TransactionCanceledException({
        $metadata: {},
        message: "Transaction cancelled",
        CancellationReasons: puts.map(() => ({ Code: "ConditionalCheckFailed" })),
      });
    }
    for (const put of puts) {
      this.items.set(keyOf(put.Item), put.Item ?? {});
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

export function createTestApp(env: NodeJS.ProcessEnv = {}): TestApp {
  const config = testConfig(env);
  const s3Client = new S3Client({ region: config.awsRegion });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }));
  const s3 = mockClient(s3Client);
  const dynamodb = mockClient(documentClient);
  const table = new FakeTable();
  table.attach(dynamodb);

  const app = createApp({ config, logger: createLogger(config.logLevel), s3: s3Client, dynamodb: documentClient });
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

export function objectBody(bytes: Buffer): GetObjectCommandOutput["Body"] {
  return Readable.from([bytes]) as unknown as GetObjectCommandOutput["Body"];
}

// A body that fails before yielding a single byte.
export function failingObjectBody(error: Error): GetObjectCommandOutput["Body"] {
  const body = new Readable({
    read() {
      this.destroy(error);
    },
  });
  return body as unknown as GetObjectCommandOutput["Body"];
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
