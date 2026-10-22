import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";
import { pinoHttp, type HttpLogger } from "pino-http";

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
      censor: "[redacted]",
    },
  });
}

export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    genReqId: () => randomUUID(),
    autoLogging: { ignore: (req) => req.url === "/healthz" },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  });
}
