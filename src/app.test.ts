import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import request from "supertest";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import { createTestApp, FakeTable, signIn, testConfig, testSigner } from "./test-support.js";

function createAppWithPages(publicDir: string) {
  const config = testConfig();
  const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }));
  new FakeTable().attach(mockClient(dynamodb));
  const s3 = new S3Client({ region: config.awsRegion });
  mockClient(s3);
  return createApp({ config, logger: createLogger("silent"), s3, dynamodb, signer: testSigner(config), publicDir });
}

describe("GET /healthz", () => {
  it("reports process health without authentication", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/healthz").expect(200);
    assert.equal(response.body.status, "ok");
    assert.equal(typeof response.body.uptimeSeconds, "number");
    assert.equal(typeof response.body.memory.rss, "number");
    assert.equal(typeof response.body.memory.heapUsed, "number");
    assert.equal(response.headers["x-powered-by"], undefined);
  });
});

describe("response headers", () => {
  it("sends a same-origin content security policy", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/healthz").expect(200);
    const csp = String(response.headers["content-security-policy"]);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /img-src 'self' blob: data:/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  });

  it("allows images from and uploads to the bucket's origin only", async () => {
    const { app, config } = createTestApp();
    const response = await request(app).get("/healthz").expect(200);
    const csp = String(response.headers["content-security-policy"]);
    assert.equal(config.s3PublicOrigin, "https://idv-documents-test.s3.eu-west-1.amazonaws.com");
    assert.match(csp, /img-src 'self' blob: data: https:\/\/idv-documents-test\.s3\.eu-west-1\.amazonaws\.com;/);
    assert.match(csp, /connect-src 'self' https:\/\/idv-documents-test\.s3\.eu-west-1\.amazonaws\.com;/);
  });

  it("follows an endpoint override", async () => {
    const { app } = createTestApp({ S3_ENDPOINT: "http://localhost:4566" });
    const response = await request(app).get("/healthz").expect(200);
    const csp = String(response.headers["content-security-policy"]);
    assert.match(csp, /img-src 'self' blob: data: http:\/\/localhost:4566;/);
    assert.match(csp, /connect-src 'self' http:\/\/localhost:4566;/);
  });
});

describe("unknown routes", () => {
  it("answer with a JSON 404", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/does-not-exist").expect(404);
    assert.deepEqual(response.body, { error: { code: "not_found", message: "Not found." } });
    await request(app).get("/api/unknown").expect(401);
    const cookie = await signIn(app, "maria@example.com");
    await request(app).get("/api/unknown").set("Cookie", cookie).expect(404);
  });
});

describe("pages", () => {
  let publicDir: string;

  before(async () => {
    publicDir = await mkdtemp(path.join(tmpdir(), "idv-public-"));
    await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>Sign in</title>");
    await writeFile(path.join(publicDir, "account.html"), "<!doctype html><title>Account</title>");
    await writeFile(path.join(publicDir, "app.css"), "body { margin: 0 }");
  });

  after(() => rm(publicDir, { recursive: true, force: true }));

  it("serves the sign-in page and redirects a signed-in user to the account", async () => {
    const app = createAppWithPages(publicDir);
    const anonymous = await request(app).get("/").expect(200);
    assert.match(anonymous.headers["content-type"] ?? "", /text\/html/);
    assert.equal(anonymous.headers["cache-control"], "no-store");
    assert.match(anonymous.text, /Sign in/);

    const cookie = await signIn(app, "maria@example.com");
    const signedIn = await request(app).get("/").set("Cookie", cookie).expect(302);
    assert.equal(signedIn.headers.location, "/account");
  });

  it("serves the account page only with a session", async () => {
    const app = createAppWithPages(publicDir);
    const anonymous = await request(app).get("/account").expect(302);
    assert.equal(anonymous.headers.location, "/");

    const cookie = await signIn(app, "maria@example.com");
    const signedIn = await request(app).get("/account").set("Cookie", cookie).expect(200);
    assert.match(signedIn.text, /Account/);
  });

  it("serves static assets with a short public cache, but never the pages", async () => {
    const app = createAppWithPages(publicDir);
    const response = await request(app).get("/app.css").expect(200);
    assert.equal(response.headers["cache-control"], "public, max-age=300");
    await request(app).get("/index.html").expect(404);
    await request(app).get("/account.html").expect(404);
  });
});
