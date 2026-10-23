import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { type AwsCredentials, assumeRoleCredentials, SignerCredentials } from "./signer-credentials.js";

const START = Date.parse("2026-10-23T10:00:00Z");
const MINUTE = 60 * 1000;

// A clock the test moves and a fetch that counts its calls.
function fixture(lifetimeMs: number | null = 60 * MINUTE) {
  const state = { now: START, fetches: 0 };
  const credentials = new SignerCredentials(async (): Promise<AwsCredentials> => {
    state.fetches += 1;
    return {
      accessKeyId: `ASIA${state.fetches}`,
      secretAccessKey: "secret",
      sessionToken: "token",
      expiration: lifetimeMs === null ? undefined : new Date(state.now + lifetimeMs),
    };
  }, () => state.now);
  return { state, credentials };
}

describe("SignerCredentials", () => {
  it("reuses credentials that cover the requested time", async () => {
    const { state, credentials } = fixture();
    const first = await credentials.validFor(6 * MINUTE);
    state.now += 50 * MINUTE;
    const second = await credentials.validFor(6 * MINUTE);
    assert.equal(second, first);
    assert.equal(state.fetches, 1);
  });

  it("refreshes when less than the requested time remains", async () => {
    const { state, credentials } = fixture();
    const first = await credentials.validFor(6 * MINUTE);
    state.now += 55 * MINUTE;
    const second = await credentials.validFor(6 * MINUTE);
    assert.notEqual(second, first);
    assert.equal(second.accessKeyId, "ASIA2");
    assert.equal(state.fetches, 2);
  });

  it("keeps credentials without an expiry", async () => {
    const { state, credentials } = fixture(null);
    await credentials.validFor(6 * MINUTE);
    state.now += 24 * 60 * MINUTE;
    await credentials.validFor(30 * MINUTE);
    assert.equal(state.fetches, 1);
  });

  it("shares one fetch between concurrent callers", async () => {
    let release = () => {};
    let fetches = 0;
    const credentials = new SignerCredentials(async () => {
      fetches += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { accessKeyId: "ASIA1", secretAccessKey: "secret", expiration: new Date(Date.now() + 60 * MINUTE) };
    });
    const pending = Promise.all(Array.from({ length: 20 }, () => credentials.validFor(6 * MINUTE)));
    await Promise.resolve();
    release();
    const results = await pending;
    assert.equal(fetches, 1);
    assert.ok(results.every((result) => result === results[0]));
  });

  it("does not keep a failed fetch", async () => {
    let attempts = 0;
    const credentials = new SignerCredentials(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("sts unavailable");
      return { accessKeyId: "ASIA2", secretAccessKey: "secret", expiration: new Date(Date.now() + 60 * MINUTE) };
    });
    await assert.rejects(credentials.validFor(6 * MINUTE), /sts unavailable/);
    const second = await credentials.validFor(6 * MINUTE);
    assert.equal(second.accessKeyId, "ASIA2");
    assert.equal(attempts, 2);
  });

  it("throws when even fresh credentials expire too soon", async () => {
    const { state, credentials } = fixture(15 * MINUTE);
    await assert.rejects(credentials.validFor(31 * MINUTE), /URL lifetime is longer than the signer session/);
    assert.equal(state.fetches, 1);
    // They still serve shorter URLs.
    await credentials.validFor(6 * MINUTE);
    assert.equal(state.fetches, 1);
  });
});

function signerRole(now?: () => number) {
  return assumeRoleCredentials({
    roleArn: "arn:aws:iam::123456789012:role/idv-portal-signer",
    region: "eu-west-1",
    sessionName: "idv-portal-signer",
    now,
  });
}

describe("assumeRoleCredentials", () => {
  const sts = mockClient(STSClient);

  afterEach(() => {
    sts.reset();
  });

  after(() => {
    sts.restore();
  });

  it("assumes the signer role for an hour and maps the credentials", async () => {
    let now = START;
    sts.on(AssumeRoleCommand).callsFake(() => ({
      Credentials: {
        AccessKeyId: "ASIAROLE",
        SecretAccessKey: "role-secret",
        SessionToken: "role-token",
        Expiration: new Date(now + 60 * MINUTE),
      },
    }));
    const credentials = signerRole(() => now);

    const first = await credentials.validFor(6 * MINUTE);
    assert.deepEqual(first, {
      accessKeyId: "ASIAROLE",
      secretAccessKey: "role-secret",
      sessionToken: "role-token",
      expiration: new Date(START + 60 * MINUTE),
    });
    const calls = sts.commandCalls(AssumeRoleCommand);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args[0].input, {
      RoleArn: "arn:aws:iam::123456789012:role/idv-portal-signer",
      RoleSessionName: "idv-portal-signer",
      DurationSeconds: 3600,
    });

    now += 30 * MINUTE;
    await credentials.validFor(6 * MINUTE);
    assert.equal(sts.commandCalls(AssumeRoleCommand).length, 1);
    now += 25 * MINUTE;
    await credentials.validFor(6 * MINUTE);
    assert.equal(sts.commandCalls(AssumeRoleCommand).length, 2);
  });

  it("rejects incomplete credentials", async () => {
    sts.on(AssumeRoleCommand).resolves({
      Credentials: { AccessKeyId: "ASIAROLE", SecretAccessKey: "secret", SessionToken: undefined, Expiration: new Date() },
    });
    await assert.rejects(signerRole().validFor(MINUTE), /incomplete credentials/);
  });

  it("passes STS failures on", async () => {
    sts.on(AssumeRoleCommand).rejects(new Error("AccessDenied"));
    await assert.rejects(signerRole().validFor(MINUTE), /AccessDenied/);
  });
});
