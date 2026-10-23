import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

// The fields of the SDK's AwsCredentialIdentity that signing uses.
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  expiration?: Date | undefined;
}

// Role chaining (instance role -> signer role) caps a session at one hour.
const ASSUME_ROLE_DURATION_SECONDS = 3600;

// Holds the credentials presigned URLs are signed with. A URL signed with
// temporary credentials stops working when they expire, whatever its own
// expiry says, and the SDK neither refuses nor refreshes for that reason, so
// callers ask for credentials that outlive the URL they are about to sign.
export class SignerCredentials {
  private current: AwsCredentials | undefined;
  private pending: Promise<AwsCredentials> | undefined;

  constructor(
    private readonly fetchCredentials: () => Promise<AwsCredentials>,
    private readonly now: () => number = Date.now,
  ) {}

  async validFor(ms: number): Promise<AwsCredentials> {
    if (this.current && this.covers(this.current, ms)) return this.current;
    const fresh = await this.refresh();
    if (!this.covers(fresh, ms)) {
      throw new Error(
        `Signing credentials expire in less than ${Math.ceil(ms / 1000)} s; ` +
          "the URL lifetime is longer than the signer session",
      );
    }
    return fresh;
  }

  private covers(credentials: AwsCredentials, ms: number): boolean {
    return credentials.expiration === undefined || credentials.expiration.getTime() - this.now() >= ms;
  }

  // Concurrent callers share one fetch; a failed fetch is not kept.
  private refresh(): Promise<AwsCredentials> {
    this.pending ??= this.fetchCredentials()
      .then((credentials) => {
        this.current = credentials;
        return credentials;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

export interface AssumeRoleOptions {
  roleArn: string;
  region: string;
  sessionName: string;
  now?: () => number;
}

// The STS client signs with the default chain, which is the instance role in production.
export function assumeRoleCredentials({ roleArn, region, sessionName, now }: AssumeRoleOptions): SignerCredentials {
  const sts = new STSClient({ region });
  return new SignerCredentials(async () => {
    const { Credentials: credentials } = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        DurationSeconds: ASSUME_ROLE_DURATION_SECONDS,
      }),
    );
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      !credentials.Expiration
    ) {
      throw new Error("AssumeRole returned incomplete credentials");
    }
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration,
    };
  }, now);
}

// A new chain per fetch, so expiring profile or instance credentials are read again.
export function defaultChainCredentials(): SignerCredentials {
  return new SignerCredentials(() => fromNodeProviderChain()());
}
