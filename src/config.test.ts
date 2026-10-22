import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, loadDynamoDBConfig } from "./config.js";

const required = { AWS_REGION: "eu-west-1", S3_BUCKET: "documents" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(required);
    assert.equal(config.port, 8080);
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.isProduction, false);
    assert.equal(config.awsRegion, "eu-west-1");
    assert.equal(config.s3Bucket, "documents");
    assert.equal(config.dynamodbTable, "idv-portal");
    assert.equal(config.s3Endpoint, undefined);
    assert.equal(config.dynamodbEndpoint, undefined);
    assert.equal(config.maxUploadBytes, 10 * 1024 * 1024);
    assert.equal(config.maxConcurrentUploads, 100);
    assert.equal(config.sessionTtlSeconds, 7 * 24 * 60 * 60);
    assert.equal(config.trustProxy, 0);
    assert.equal(config.logLevel, "info");
  });

  it("requires the region and the bucket", () => {
    assert.throws(() => loadConfig({ S3_BUCKET: "documents" }), /AWS_REGION/);
    assert.throws(() => loadConfig({ AWS_REGION: "eu-west-1" }), /S3_BUCKET/);
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({ ...required, S3_ENDPOINT: "", DYNAMODB_TABLE: "", PORT: "" });
    assert.equal(config.s3Endpoint, undefined);
    assert.equal(config.dynamodbTable, "idv-portal");
    assert.equal(config.port, 8080);
  });

  it("parses numbers and endpoints", () => {
    const config = loadConfig({
      ...required,
      PORT: "9000",
      MAX_UPLOAD_MB: "2",
      MAX_CONCURRENT_UPLOADS: "3",
      SESSION_TTL_DAYS: "1",
      S3_ENDPOINT: "http://localhost:9000",
      DYNAMODB_ENDPOINT: "http://localhost:8000",
      LOG_LEVEL: "debug",
    });
    assert.equal(config.port, 9000);
    assert.equal(config.maxUploadBytes, 2 * 1024 * 1024);
    assert.equal(config.maxConcurrentUploads, 3);
    assert.equal(config.sessionTtlSeconds, 86400);
    assert.equal(config.s3Endpoint, "http://localhost:9000");
    assert.equal(config.dynamodbEndpoint, "http://localhost:8000");
    assert.equal(config.logLevel, "debug");
  });

  it("trusts one proxy hop in production unless told otherwise", () => {
    assert.equal(loadConfig({ ...required, NODE_ENV: "production" }).isProduction, true);
    assert.equal(loadConfig({ ...required, NODE_ENV: "production" }).trustProxy, 1);
    assert.equal(loadConfig({ ...required, NODE_ENV: "production", TRUST_PROXY: "false" }).trustProxy, false);
    assert.equal(loadConfig({ ...required, TRUST_PROXY: "2" }).trustProxy, 2);
    assert.equal(loadConfig({ ...required, TRUST_PROXY: "loopback" }).trustProxy, "loopback");
  });

  it("rejects invalid values", () => {
    assert.throws(() => loadConfig({ ...required, PORT: "http" }), /PORT/);
    assert.throws(() => loadConfig({ ...required, MAX_UPLOAD_MB: "-1" }), /MAX_UPLOAD_MB/);
    assert.throws(() => loadConfig({ ...required, LOG_LEVEL: "loud" }), /LOG_LEVEL/);
    assert.throws(() => loadConfig({ ...required, S3_ENDPOINT: "not a url" }), /S3_ENDPOINT/);
    assert.throws(() => loadConfig({ ...required, MAX_CONCURRENT_UPLOADS: "0" }), /MAX_CONCURRENT_UPLOADS/);
    assert.throws(() => loadConfig({ ...required, TRUST_PROXY: "true" }), /TRUST_PROXY/);
  });
});

describe("loadDynamoDBConfig", () => {
  it("needs the region only", () => {
    const config = loadDynamoDBConfig({ AWS_REGION: "eu-west-1", DYNAMODB_ENDPOINT: "http://localhost:8000" });
    assert.deepEqual(config, { awsRegion: "eu-west-1", dynamodbTable: "idv-portal", dynamodbEndpoint: "http://localhost:8000" });
    assert.throws(() => loadDynamoDBConfig({ DYNAMODB_TABLE: "idv-portal" }), /AWS_REGION/);
  });
});
