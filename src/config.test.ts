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
    assert.equal(config.s3SignerRoleArn, undefined);
    assert.equal(config.dynamodbEndpoint, undefined);
    assert.equal(config.maxUploadBytes, 10 * 1024 * 1024);
    assert.equal(config.uploadUrlTtlSeconds, 300);
    assert.equal(config.downloadUrlTtlSeconds, 60);
    assert.equal(config.sessionTtlSeconds, 7 * 24 * 60 * 60);
    assert.equal(config.trustProxy, 0);
    assert.equal(config.logLevel, "info");
  });

  it("requires the region and the bucket", () => {
    assert.throws(() => loadConfig({ S3_BUCKET: "documents" }), /AWS_REGION/);
    assert.throws(() => loadConfig({ AWS_REGION: "eu-west-1" }), /S3_BUCKET/);
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({ ...required, S3_ENDPOINT: "", DYNAMODB_TABLE: "", PORT: "", S3_SIGNER_ROLE_ARN: "" });
    assert.equal(config.s3Endpoint, undefined);
    assert.equal(config.s3SignerRoleArn, undefined);
    assert.equal(config.dynamodbTable, "idv-portal");
    assert.equal(config.port, 8080);
  });

  it("parses numbers and endpoints", () => {
    const config = loadConfig({
      ...required,
      PORT: "9000",
      MAX_UPLOAD_MB: "2",
      UPLOAD_URL_TTL_SECONDS: "600",
      DOWNLOAD_URL_TTL_SECONDS: "30",
      SESSION_TTL_DAYS: "1",
      S3_ENDPOINT: "http://localhost:9000",
      DYNAMODB_ENDPOINT: "http://localhost:8000",
      S3_SIGNER_ROLE_ARN: "arn:aws:iam::123456789012:role/idv-portal-signer",
      LOG_LEVEL: "debug",
    });
    assert.equal(config.port, 9000);
    assert.equal(config.maxUploadBytes, 2 * 1024 * 1024);
    assert.equal(config.uploadUrlTtlSeconds, 600);
    assert.equal(config.downloadUrlTtlSeconds, 30);
    assert.equal(config.sessionTtlSeconds, 86400);
    assert.equal(config.s3Endpoint, "http://localhost:9000");
    assert.equal(config.dynamodbEndpoint, "http://localhost:8000");
    assert.equal(config.s3SignerRoleArn, "arn:aws:iam::123456789012:role/idv-portal-signer");
    assert.equal(config.logLevel, "debug");
  });

  it("derives the origin the browser uses for S3", () => {
    assert.equal(loadConfig(required).s3PublicOrigin, "https://documents.s3.eu-west-1.amazonaws.com");
    assert.equal(
      loadConfig({ ...required, AWS_REGION: "us-east-1" }).s3PublicOrigin,
      "https://documents.s3.us-east-1.amazonaws.com",
    );
    assert.equal(
      loadConfig({ ...required, S3_ENDPOINT: "http://localhost:4566/" }).s3PublicOrigin,
      "http://localhost:4566",
    );
  });

  it("refuses bucket names with dots unless an endpoint is set", () => {
    assert.throws(
      () => loadConfig({ ...required, S3_BUCKET: "idv.portal.example" }),
      /Invalid configuration: S3_BUCKET must not contain dots/,
    );
    const local = loadConfig({ ...required, S3_BUCKET: "idv.portal.example", S3_ENDPOINT: "http://localhost:4566" });
    assert.equal(local.s3PublicOrigin, "http://localhost:4566");
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
    assert.throws(() => loadConfig({ ...required, TRUST_PROXY: "true" }), /TRUST_PROXY/);
    assert.throws(() => loadConfig({ ...required, S3_SIGNER_ROLE_ARN: "idv-portal-signer" }), /S3_SIGNER_ROLE_ARN/);
  });

  it("keeps the URL lifetimes within bounds", () => {
    assert.throws(() => loadConfig({ ...required, UPLOAD_URL_TTL_SECONDS: "59" }), /UPLOAD_URL_TTL_SECONDS/);
    assert.throws(() => loadConfig({ ...required, UPLOAD_URL_TTL_SECONDS: "1801" }), /UPLOAD_URL_TTL_SECONDS/);
    assert.throws(() => loadConfig({ ...required, UPLOAD_URL_TTL_SECONDS: "90.5" }), /UPLOAD_URL_TTL_SECONDS/);
    assert.throws(() => loadConfig({ ...required, DOWNLOAD_URL_TTL_SECONDS: "9" }), /DOWNLOAD_URL_TTL_SECONDS/);
    assert.throws(() => loadConfig({ ...required, DOWNLOAD_URL_TTL_SECONDS: "1801" }), /DOWNLOAD_URL_TTL_SECONDS/);
    assert.equal(loadConfig({ ...required, UPLOAD_URL_TTL_SECONDS: "1800" }).uploadUrlTtlSeconds, 1800);
    assert.equal(loadConfig({ ...required, DOWNLOAD_URL_TTL_SECONDS: "10" }).downloadUrlTtlSeconds, 10);
  });
});

describe("loadDynamoDBConfig", () => {
  it("needs the region only", () => {
    const config = loadDynamoDBConfig({ AWS_REGION: "eu-west-1", DYNAMODB_ENDPOINT: "http://localhost:8000" });
    assert.deepEqual(config, { awsRegion: "eu-west-1", dynamodbTable: "idv-portal", dynamodbEndpoint: "http://localhost:8000" });
    assert.throws(() => loadDynamoDBConfig({ DYNAMODB_TABLE: "idv-portal" }), /AWS_REGION/);
  });
});
