import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createDocumentClient } from "./storage/dynamodb.js";
import { createS3Client } from "./storage/s3.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

const app = createApp({
  config,
  logger,
  s3: createS3Client({ region: config.awsRegion, endpoint: config.s3Endpoint }),
  dynamodb: createDocumentClient({ region: config.awsRegion, endpoint: config.dynamodbEndpoint }),
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, "server listening");
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
