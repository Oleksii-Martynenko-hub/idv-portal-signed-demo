import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { type Request, type RequestHandler, type Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { currentSession } from "../auth/session.js";
import type { Config } from "../config.js";
import { errorBody, HttpError, notFound } from "../http/errors.js";
import type { ObjectStore } from "../storage/s3.js";
import { contentDisposition, sanitizeFileName } from "./file-name.js";
import { detectImageType, extensionFor } from "./file-type.js";
import { DOCUMENT_KINDS, type DocumentKind, type DocumentRecord, type DocumentRepository } from "./repository.js";

export interface DocumentsDependencies {
  documents: DocumentRepository;
  store: ObjectStore;
  config: Pick<Config, "maxUploadBytes" | "maxConcurrentUploads">;
}

export interface DocumentView {
  id: string;
  kind: DocumentKind;
  fileName: string;
  contentType: string;
  size: number;
  status: "received";
  createdAt: string;
}

// Room for the multipart boundaries and part headers around the file itself.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const BYTES_PER_MIB = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_UNAVAILABLE = "File storage is temporarily unavailable. Try again later.";
const MAX_DOCUMENTS_PER_USER = 20;
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_LIMIT = 30;

const uploadFieldsSchema = z.object({ kind: z.enum(DOCUMENT_KINDS) });

export function documentsRouter({ documents, store, config }: DocumentsDependencies): Router {
  const router = Router();

  const limitLabel = `${Math.round((config.maxUploadBytes / BYTES_PER_MIB) * 10) / 10} MB`;
  const fileTooLarge = () => new HttpError(413, "file_too_large", `Files must be ${limitLabel} or smaller.`);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 1 },
    defParamCharset: "utf8",
  });
  const receiveFile = upload.single("file");

  const readUpload: RequestHandler = (req, res, next) => {
    receiveFile(req, res, (error: unknown) => next(mapUploadError(error, fileTooLarge)));
  };

  const uploadLimiter = rateLimit({
    windowMs: UPLOAD_WINDOW_MS,
    limit: UPLOAD_LIMIT,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => currentSession(req).userId,
    handler: (_req, res) => {
      res.status(429).json(errorBody("too_many_requests", "Too many uploads. Try again later."));
    },
  });

  const enforceDocumentLimit: RequestHandler = async (req, _res, next) => {
    const owned = await documents.listByOwner(currentSession(req).userId);
    if (owned.length >= MAX_DOCUMENTS_PER_USER) {
      next(
        new HttpError(
          409,
          "document_limit_reached",
          `You can keep up to ${MAX_DOCUMENTS_PER_USER} documents. Delete one to upload another.`,
        ),
      );
      return;
    }
    next();
  };

  // Each upload is held in memory whole, so the number in flight is bounded.
  let activeUploads = 0;
  const reserveUploadSlot: RequestHandler = (_req, res, next) => {
    if (activeUploads >= config.maxConcurrentUploads) {
      res.setHeader("Retry-After", "5");
      next(new HttpError(503, "server_busy", "The service is busy. Try again in a moment."));
      return;
    }
    activeUploads += 1;
    res.once("close", () => {
      activeUploads -= 1;
    });
    next();
  };

  router.get("/", async (req, res) => {
    const session = currentSession(req);
    const list = await documents.listByOwner(session.userId);
    res.json({ documents: list.map(presentDocument) });
  });

  router.post(
    "/",
    uploadLimiter,
    requireContentLength(config.maxUploadBytes + MULTIPART_OVERHEAD_BYTES, fileTooLarge),
    enforceDocumentLimit,
    reserveUploadSlot,
    readUpload,
    async (req, res) => {
      const session = currentSession(req);

      const fields = uploadFieldsSchema.safeParse(req.body);
      if (!fields.success) {
        throw new HttpError(400, "invalid_kind", "Choose a document type.");
      }
      const file = req.file;
      if (!file) {
        throw new HttpError(400, "bad_upload", 'Attach the document in the "file" field.');
      }
      if (file.size === 0) {
        throw new HttpError(400, "empty_file", "The file is empty.");
      }
      const contentType = await detectImageType(file.buffer);
      if (!contentType) {
        throw new HttpError(415, "unsupported_file_type", "Upload a JPEG, PNG or WebP image.");
      }

      const id = randomUUID();
      const document: DocumentRecord = {
        id,
        userId: session.userId,
        kind: fields.data.kind,
        fileName: sanitizeFileName(file.originalname, extensionFor(contentType)),
        contentType,
        size: file.size,
        s3Key: objectKeyFor(session.userId, id),
        status: "received",
        createdAt: new Date().toISOString(),
      };

      await viaStorage(store.put(document.s3Key, file.buffer, contentType));
      try {
        await documents.put(document);
      } catch (error) {
        await discardObject(req, store, document.s3Key);
        throw error;
      }

      res.status(201).json({ document: presentDocument(document) });
    },
  );

  router.get("/:id/file", async (req, res) => {
    const document = await findOwned(req);
    const object = await viaStorage(store.get(document.s3Key));
    if (!object) {
      throw notFound();
    }

    res.status(200);
    res.setHeader("Content-Type", document.contentType);
    if (object.contentLength !== undefined) {
      res.setHeader("Content-Length", String(object.contentLength));
    }
    res.setHeader("Content-Disposition", contentDisposition(document.fileName));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    try {
      await sendStream(object.body, res);
    } catch (error) {
      if (!res.headersSent) {
        for (const header of ["Content-Type", "Content-Length", "Content-Disposition", "Cache-Control"]) {
          res.removeHeader(header);
        }
        throw new HttpError(502, "storage_unavailable", STORAGE_UNAVAILABLE, { cause: error });
      }
      req.log.warn({ err: error }, "document stream ended early");
      res.destroy();
    }
  });

  router.delete("/:id", async (req, res) => {
    const document = await findOwned(req);
    await viaStorage(store.delete(document.s3Key));
    await documents.delete(document.userId, document.id);
    res.status(204).end();
  });

  async function findOwned(req: Request<{ id: string }>): Promise<DocumentRecord> {
    const session = currentSession(req);
    if (!UUID_PATTERN.test(req.params.id)) {
      throw notFound();
    }
    const document = await documents.findByOwner(session.userId, req.params.id);
    if (!document) {
      throw notFound();
    }
    return document;
  }

  return router;
}

function presentDocument(document: DocumentRecord): DocumentView {
  const { id, kind, fileName, contentType, size, status, createdAt } = document;
  return { id, kind, fileName, contentType, size, status, createdAt };
}

function objectKeyFor(userId: string, documentId: string): string {
  return `users/${userId}/documents/${documentId}`;
}

// Rejects bodies that cannot fit before any of them is read.
function requireContentLength(maxBytes: number, tooLarge: () => HttpError): RequestHandler {
  return (req, res, next) => {
    const header = req.headers["content-length"];
    if (header === undefined) {
      next(new HttpError(411, "length_required", "Content-Length is required."));
      return;
    }
    if (Number(header) > maxBytes) {
      res.setHeader("Connection", "close");
      next(tooLarge());
      return;
    }
    next();
  };
}

function mapUploadError(error: unknown, tooLarge: () => HttpError): unknown {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") return tooLarge();
    return new HttpError(400, "bad_upload", "The upload could not be read.", { cause: error });
  }
  return error;
}

async function viaStorage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw new HttpError(502, "storage_unavailable", STORAGE_UNAVAILABLE, { cause: error });
  }
}

// Nothing records the object once the item write has failed, so it is removed
// on a best-effort basis; the original failure is what the client hears about.
async function discardObject(req: Request, store: ObjectStore, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    req.log.warn({ err: error }, "could not remove the object of a failed upload");
  }
}

// Pipes without destroying the response on a source error, so a failure before
// the first byte can still be reported as a proper error response.
function sendStream(body: Readable, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    body.once("error", (error) => {
      body.unpipe(res);
      reject(error);
    });
    res.once("close", () => {
      body.destroy();
      resolve();
    });
    body.pipe(res);
  });
}
