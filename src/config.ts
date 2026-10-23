import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const dynamodbEnvSchema = z.object({
  AWS_REGION: z.string().min(1),
  DYNAMODB_TABLE: z.string().min(1).default("idv-portal"),
  DYNAMODB_ENDPOINT: z.url().optional(),
});

const envSchema = dynamodbEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  NODE_ENV: z.string().default("development"),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_SIGNER_ROLE_ARN: z
    .string()
    .regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/, "expected an IAM role ARN")
    .optional(),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(1800).default(60),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(7),
  TRUST_PROXY: z.string().optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

export interface DynamoDBConfig {
  awsRegion: string;
  dynamodbTable: string;
  dynamodbEndpoint: string | undefined;
}

export interface Config extends DynamoDBConfig {
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  s3Bucket: string;
  s3Endpoint: string | undefined;
  // Origin of every presigned URL; the browser talks to it directly.
  s3PublicOrigin: string;
  s3SignerRoleArn: string | undefined;
  maxUploadBytes: number;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  sessionTtlSeconds: number;
  trustProxy: boolean | number | string;
  logLevel: LogLevel;
}

const BYTES_PER_MIB = 1024 * 1024;
const SECONDS_PER_DAY = 24 * 60 * 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const vars = parseEnv(envSchema, env);
  const isProduction = vars.NODE_ENV === "production";
  return {
    port: vars.PORT,
    nodeEnv: vars.NODE_ENV,
    isProduction,
    awsRegion: vars.AWS_REGION,
    s3Bucket: vars.S3_BUCKET,
    dynamodbTable: vars.DYNAMODB_TABLE,
    s3Endpoint: vars.S3_ENDPOINT,
    s3PublicOrigin: s3PublicOrigin(vars.S3_BUCKET, vars.AWS_REGION, vars.S3_ENDPOINT),
    s3SignerRoleArn: vars.S3_SIGNER_ROLE_ARN,
    dynamodbEndpoint: vars.DYNAMODB_ENDPOINT,
    maxUploadBytes: Math.floor(vars.MAX_UPLOAD_MB * BYTES_PER_MIB),
    uploadUrlTtlSeconds: vars.UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: vars.DOWNLOAD_URL_TTL_SECONDS,
    sessionTtlSeconds: Math.floor(vars.SESSION_TTL_DAYS * SECONDS_PER_DAY),
    trustProxy: parseTrustProxy(vars.TRUST_PROXY, isProduction),
    logLevel: vars.LOG_LEVEL,
  };
}

// The subset the table script needs; it runs before a bucket exists.
export function loadDynamoDBConfig(env: NodeJS.ProcessEnv = process.env): DynamoDBConfig {
  const vars = parseEnv(dynamodbEnvSchema, env);
  return { awsRegion: vars.AWS_REGION, dynamodbTable: vars.DYNAMODB_TABLE, dynamodbEndpoint: vars.DYNAMODB_ENDPOINT };
}

function parseEnv<Schema extends z.ZodType>(schema: Schema, env: NodeJS.ProcessEnv): z.output<Schema> {
  // An empty value (S3_ENDPOINT= in a .env file) counts as unset.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// With an endpoint override the clients use path-style URLs on that host.
// Against AWS they use the virtual-hosted name, whose wildcard certificate
// does not cover bucket names with dots (the SDK would quietly switch to
// path-style and the CSP would not match).
function s3PublicOrigin(bucket: string, region: string, endpoint: string | undefined): string {
  if (endpoint) return new URL(endpoint).origin;
  if (bucket.includes(".")) {
    throw new Error("Invalid configuration: S3_BUCKET must not contain dots unless S3_ENDPOINT is set");
  }
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

// Express accepts a hop count, "false" or a subnet list for "trust proxy".
// "true" would trust X-Forwarded-For from any client and make req.ip, and
// everything keyed on it, spoofable, so it is refused.
function parseTrustProxy(raw: string | undefined, isProduction: boolean): boolean | number | string {
  if (raw === undefined) return isProduction ? 1 : 0;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "true") {
    throw new Error('Invalid configuration: TRUST_PROXY must be "false", a hop count or a subnet list');
  }
  return raw;
}
