import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createDocumentClient } from "./storage/dynamodb.js";
import { UrlSigner } from "./storage/presigner.js";
import { createS3Client } from "./storage/s3.js";
import { assumeRoleCredentials, defaultChainCredentials } from "./storage/signer-credentials.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SIGNER_SESSION_NAME = "idv-portal-signer";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

// Presigned URLs are signed by a role that may only write staging and read
// promoted files; without one (local development) the default chain signs.
const signerCredentials = config.s3SignerRoleArn
  ? assumeRoleCredentials({
      roleArn: config.s3SignerRoleArn,
      region: config.awsRegion,
      sessionName: SIGNER_SESSION_NAME,
    })
  : defaultChainCredentials();

// Every upload would then fail at S3 with 403, which this service never sees.
if (config.isProduction && !config.s3SignerRoleArn) {
  logger.warn(
    "S3_SIGNER_ROLE_ARN is not set: presigned URLs are signed with the instance credentials, which cannot write to staging/",
  );
}

const app = createApp({
  config,
  logger,
  s3: createS3Client({ region: config.awsRegion, endpoint: config.s3Endpoint }),
  dynamodb: createDocumentClient({ region: config.awsRegion, endpoint: config.dynamodbEndpoint }),
  signer: new UrlSigner({
    bucket: config.s3Bucket,
    region: config.awsRegion,
    endpoint: config.s3Endpoint,
    credentials: signerCredentials,
  }),
});

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.nodeEnv, signer: config.s3SignerRoleArn ? "role" : "default chain" },
    "server listening",
  );
});

server.on("error", (error) => {
  logger.fatal({ err: error }, "server failed to start");
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  const deadline = setTimeout(() => {
    logger.warn("connections still open after timeout, exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "server did not close cleanly");
      process.exit(1);
    }
    logger.info("server closed");
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
