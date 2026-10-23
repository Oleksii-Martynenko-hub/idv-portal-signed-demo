import path from "node:path";
import { fileURLToPath } from "node:url";
import type { S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import express, { type Express, type Response, Router } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { SessionRepository } from "./auth/repository.js";
import { authRouter, currentUserRouter } from "./auth/routes.js";
import { requireSession, resolveSession } from "./auth/session.js";
import type { Config } from "./config.js";
import { DocumentRepository } from "./documents/repository.js";
import { documentsRouter } from "./documents/routes.js";
import { documentPresenter } from "./documents/view.js";
import { csrfProtection } from "./http/csrf.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { createHttpLogger } from "./logger.js";
import type { UrlSigner } from "./storage/presigner.js";
import { ObjectStore } from "./storage/s3.js";
import { PendingUploadRepository } from "./uploads/repository.js";
import { uploadsRouter } from "./uploads/routes.js";
import { UserRepository } from "./users/repository.js";

export interface AppDependencies {
  config: Config;
  logger: Logger;
  s3: S3Client;
  dynamodb: DynamoDBDocumentClient;
  signer: UrlSigner;
  publicDir?: string;
}

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const STATIC_MAX_AGE_MS = 5 * 60 * 1000;

export function createApp({
  config,
  logger,
  s3,
  dynamodb,
  signer,
  publicDir = DEFAULT_PUBLIC_DIR,
}: AppDependencies): Express {
  const users = new UserRepository(dynamodb, config.dynamodbTable);
  const sessions = new SessionRepository(dynamodb, config.dynamodbTable);
  const documents = new DocumentRepository(dynamodb, config.dynamodbTable);
  const uploads = new PendingUploadRepository(dynamodb, config.dynamodbTable);
  const store = new ObjectStore(s3, config.s3Bucket);
  const presentDocument = documentPresenter(signer, config.downloadUrlTtlSeconds);
  const withSession = resolveSession(sessions);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(createHttpLogger(logger));
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          // Thumbnails load from presigned URLs and the file goes straight to S3.
          "img-src": ["'self'", "blob:", "data:", config.s3PublicOrigin],
          "connect-src": ["'self'", config.s3PublicOrigin],
          "font-src": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
          ...(config.isProduction ? { "upgrade-insecure-requests": [] } : {}),
        },
      },
    }),
  );

  app.get("/healthz", (_req, res) => {
    const memory = process.memoryUsage();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    });
  });

  // Pages go through the routes below, which look at the session first.
  const serveAssets = express.static(publicDir, { index: false, maxAge: STATIC_MAX_AGE_MS });
  app.use((req, res, next) => {
    if (/\.html$/i.test(req.path)) {
      next();
      return;
    }
    serveAssets(req, res, next);
  });
  app.use(csrfProtection);

  const sendPage = (res: Response, fileName: string) => {
    res.sendFile(path.join(publicDir, fileName), { headers: { "Cache-Control": "no-store" } });
  };

  app.get("/", withSession, (req, res) => {
    if (req.session) {
      res.redirect(302, "/account");
    } else {
      sendPage(res, "index.html");
    }
  });

  app.get("/account", withSession, (req, res) => {
    if (req.session) {
      sendPage(res, "account.html");
    } else {
      res.redirect(302, "/");
    }
  });

  app.use("/auth", authRouter({ users, sessions, config }));

  const api = Router();
  api.use(withSession, requireSession);
  api.use("/me", currentUserRouter({ users }));
  api.use("/documents", documentsRouter({ documents, store, presentDocument }));
  api.use("/uploads", uploadsRouter({ uploads, documents, store, signer, presentDocument, config }));
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
