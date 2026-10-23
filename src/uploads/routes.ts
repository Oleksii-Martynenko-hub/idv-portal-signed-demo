import { randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import express, { type Request, Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Logger } from "pino";
import { z } from "zod";
import { currentSession } from "../auth/session.js";
import type { Config } from "../config.js";
import { contentDisposition, sanitizeFileName } from "../documents/file-name.js";
import { detectImageType, extensionFor, type ImageType, isImageType } from "../documents/file-type.js";
import { fileKeyFor, stagingKeyFor } from "../documents/keys.js";
import {
  DOCUMENT_KINDS,
  type DocumentKind,
  type DocumentRepository,
  type ReceivedDocument,
  type RejectedDocument,
} from "../documents/repository.js";
import { type DocumentPresenter, documentSummary } from "../documents/view.js";
import { errorBody, HttpError, notFound, storageUnavailable, viaStorage } from "../http/errors.js";
import type { UrlSigner } from "../storage/presigner.js";
import { ObjectChangedError, type ObjectStore } from "../storage/s3.js";
import {
  inspectStagedObject,
  type Rejection,
  rejection,
  STAGING_CACHE_CONTROL,
  STAGING_CONTENT_DISPOSITION,
} from "./inspection.js";
import type { PendingUpload, PendingUploadRepository } from "./repository.js";

export interface UploadsDependencies {
  uploads: PendingUploadRepository;
  documents: DocumentRepository;
  store: ObjectStore;
  signer: UrlSigner;
  presentDocument: DocumentPresenter;
  config: Pick<Config, "maxUploadBytes" | "uploadUrlTtlSeconds">;
}

interface UploadRequest {
  kind: DocumentKind;
  fileName: string;
  size: number;
  contentType: ImageType;
  checksumSha256: string;
}

const BYTES_PER_MIB = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Base64 of a 32-byte SHA-256 digest.
const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const MAX_FILE_NAME_INPUT_LENGTH = 1024;
const MAX_DOCUMENTS_PER_USER = 20;
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_LIMIT = 30;
// A PUT that starts just before the URL expires may still be running for a while.
const COMPLETION_GRACE_MS = 10 * 60 * 1000;
// Enough for the format detection to recognise every accepted type.
const SNIFF_BYTES = 4100;
const FILE_CACHE_CONTROL = "private, no-store";

const kindSchema = z.enum(DOCUMENT_KINDS);

type Inspection =
  | { outcome: "missing" }
  | { outcome: "rejected"; rejection: Rejection }
  | { outcome: "accepted"; document: ReceivedDocument };

export function uploadsRouter(dependencies: UploadsDependencies): Router {
  const { uploads, documents, store, signer, presentDocument, config } = dependencies;
  const router = Router();

  const limitLabel = `${Math.round((config.maxUploadBytes / BYTES_PER_MIB) * 10) / 10} MB`;

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

  router.post("/", uploadLimiter, express.json({ limit: "10kb" }), async (req, res) => {
    const session = currentSession(req);
    const request = parseUploadRequest(req.body, config.maxUploadBytes, limitLabel);

    const [owned, pending] = await Promise.all([
      documents.listByOwner(session.userId),
      uploads.listByOwner(session.userId),
    ]);
    const now = Date.now();
    // The table's TTL would remove only the record, not a copy an interrupted completion left in files/.
    const expired = pending.filter((upload) => now > completionDeadline(upload));
    await Promise.all(expired.map((upload) => sweepExpired(req.log, session.userId, upload.id)));

    // Uploads still in flight count too, so URLs requested one after another cannot outrun the
    // cap. Simultaneous requests can overshoot it slightly, bounded by the rate limiter.
    const open = pending.filter((upload) => now <= completionDeadline(upload));
    if (owned.length + open.length >= MAX_DOCUMENTS_PER_USER) {
      throw new HttpError(
        409,
        "document_limit_reached",
        `You can keep up to ${MAX_DOCUMENTS_PER_USER} documents. Delete one to upload another.`,
      );
    }

    const id = randomUUID();
    const stagingKey = stagingKeyFor(session.userId, id);
    const presigned = await viaStorage(
      signer.presignUpload({
        key: stagingKey,
        contentType: request.contentType,
        size: request.size,
        cacheControl: STAGING_CACHE_CONTROL,
        contentDisposition: STAGING_CONTENT_DISPOSITION,
        checksumSha256: request.checksumSha256,
        expiresInSeconds: config.uploadUrlTtlSeconds,
      }),
    );

    await uploads.create({
      id,
      userId: session.userId,
      kind: request.kind,
      fileName: sanitizeFileName(request.fileName, extensionFor(request.contentType)),
      contentType: request.contentType,
      size: request.size,
      stagingKey,
      checksumSha256: request.checksumSha256,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: presigned.expiresAt.toISOString(),
    });

    res.status(201).json({
      upload: {
        id,
        method: "PUT",
        url: presigned.url,
        headers: presigned.headers,
        expiresAt: presigned.expiresAt.toISOString(),
      },
    });
  });

  router.post("/:id/complete", async (req, res) => {
    const session = currentSession(req);
    const upload = await findOwnedUpload(req);
    const stagingKey = stagingKeyFor(session.userId, upload.id);
    const fileKey = fileKeyFor(session.userId, upload.id);

    if (Date.now() > completionDeadline(upload)) {
      await discardExpired(req.log, session.userId, upload.id);
      throw new HttpError(410, "upload_expired", "This upload has expired. Upload the file again.");
    }

    if (!(await uploads.claim(upload.userId, upload.id))) {
      throw uploadInProgress();
    }

    let inspection: Inspection;
    try {
      inspection = await inspectAndPromote(req.log, upload, stagingKey, fileKey);
    } catch (error) {
      await releaseClaim(req.log, upload);
      throw error;
    }

    if (inspection.outcome === "missing") {
      await releaseClaim(req.log, upload);
      throw new HttpError(409, "upload_not_received", "The file has not been uploaded yet.");
    }

    // Recorded before the staged object goes, so a failed write can be retried with the same result.
    if (inspection.outcome === "rejected") {
      const { code, message } = inspection.rejection;
      const rejected: RejectedDocument = {
        ...documentFields(upload),
        contentType: upload.contentType,
        size: upload.size,
        status: "rejected",
        rejectionCode: code,
        rejectionReason: message,
      };
      await finishOrRelease(req.log, upload, rejected);
      await discardObject(req.log, stagingKey, "could not remove a rejected staged object");
      throw new HttpError(422, code, message);
    }

    const { document } = inspection;
    try {
      await uploads.finish(upload, document);
    } catch (error) {
      // A cancelled transaction wrote nothing, so the copy belongs to no document; it goes
      // before the claim is given back, while no other completion can write that key. Any
      // other failure may have committed, so the copy stays: if it did not commit, the upload
      // record is still there for a retry, a cancel or the sweep to deal with it.
      if (error instanceof TransactionCanceledException) {
        await discardObject(req.log, document.s3Key, "could not remove the promoted object of a failed upload", "error");
      }
      await releaseClaim(req.log, upload);
      throw error;
    }
    // Lifecycle rules remove whatever is left in staging.
    await discardObject(req.log, stagingKey, "could not remove a promoted staged object");

    res.status(201).json({ document: await presentCompleted(req.log, document, session.userId) });
  });

  // Gives the place in the cap back after a PUT that failed. The URL works until it expires,
  // but nothing completes a file that arrives later and the lifecycle rule removes it.
  // While the upload record existed no document did, so a promoted copy left by an
  // earlier failed completion belongs to nothing and goes as well.
  router.delete("/:id", async (req, res) => {
    const session = currentSession(req);
    const upload = await findOwnedUpload(req);
    if (upload.status !== "pending" || !(await uploads.deletePending(session.userId, upload.id))) {
      throw uploadInProgress();
    }
    const message = "could not remove an object of a discarded upload";
    await discardObject(req.log, stagingKeyFor(session.userId, upload.id), message);
    await discardObject(req.log, fileKeyFor(session.userId, upload.id), message, "error");
    res.status(204).end();
  });

  async function inspectAndPromote(
    log: Logger,
    upload: PendingUpload,
    stagingKey: string,
    fileKey: string,
  ): Promise<Inspection> {
    const head = await viaStorage(store.head(stagingKey));
    if (!head) return { outcome: "missing" };

    const problem = inspectStagedObject(upload, head);
    if (problem) return { outcome: "rejected", rejection: problem };

    let start: Buffer;
    try {
      start = await store.readStart(stagingKey, Math.min(SNIFF_BYTES, head.size), head.eTag);
    } catch (error) {
      if (error instanceof ObjectChangedError) return { outcome: "rejected", rejection: rejection("object_changed") };
      throw storageUnavailable(error);
    }
    const contentType = await detectImageType(start);
    if (!contentType) return { outcome: "rejected", rejection: rejection("unsupported_file_type") };

    const disposition = contentDisposition(upload.fileName);
    let copiedChecksum: string | undefined;
    try {
      copiedChecksum = await store.promote({
        from: stagingKey,
        to: fileKey,
        eTag: head.eTag,
        contentType,
        cacheControl: FILE_CACHE_CONTROL,
        contentDisposition: disposition,
      });
    } catch (error) {
      if (error instanceof ObjectChangedError) return { outcome: "rejected", rejection: rejection("object_changed") };
      // A copy whose answer was lost may still have landed.
      await discardObject(log, fileKey, "could not remove the promoted object of a failed copy", "error");
      throw storageUnavailable(error);
    }
    if (copiedChecksum !== undefined && copiedChecksum !== upload.checksumSha256) {
      await discardObject(log, fileKey, "could not remove a promoted object whose checksum changed", "error");
      return { outcome: "rejected", rejection: rejection("object_changed") };
    }

    return {
      outcome: "accepted",
      document: { ...documentFields(upload), contentType, size: head.size, status: "received", s3Key: fileKey },
    };
  }

  async function finishOrRelease(log: Logger, upload: PendingUpload, document: ReceivedDocument | RejectedDocument) {
    try {
      await uploads.finish(upload, document);
    } catch (error) {
      await releaseClaim(log, upload);
      throw error;
    }
  }

  async function releaseClaim(log: Logger, upload: PendingUpload): Promise<void> {
    try {
      await uploads.release(upload.userId, upload.id);
    } catch (error) {
      log.warn({ err: error, uploadId: upload.id }, "could not release an upload claim");
    }
  }

  // Best effort: the failure the client hears about is the one that got us here. Lifecycle
  // rules clear staging/, so only a promoted object left behind is logged as an error.
  async function discardObject(log: Logger, key: string, message: string, level: "warn" | "error" = "warn") {
    try {
      await store.delete(key);
    } catch (error) {
      log[level]({ err: error, key }, message);
    }
  }

  // Removes an upload past its deadline and whatever it may have left in S3. A completion
  // that got there first has removed the record already, and its file stays.
  async function discardExpired(log: Logger, userId: string, documentId: string): Promise<void> {
    if (!(await uploads.delete(userId, documentId))) return;
    const message = "could not remove an object of an expired upload";
    await discardObject(log, stagingKeyFor(userId, documentId), message);
    await discardObject(log, fileKeyFor(userId, documentId), message, "error");
  }

  // A failure leaves the upload for a later request or the table's TTL.
  async function sweepExpired(log: Logger, userId: string, documentId: string): Promise<void> {
    try {
      await discardExpired(log, userId, documentId);
    } catch (error) {
      log.warn({ err: error, uploadId: documentId }, "could not clear an expired upload");
    }
  }

  // The document is stored by now, so a read URL that cannot be signed only leaves it out.
  async function presentCompleted(log: Logger, document: ReceivedDocument, ownerId: string) {
    try {
      return await presentDocument(document, ownerId, log);
    } catch (error) {
      log.warn({ err: error, documentId: document.id }, "could not sign a read URL for a new document");
      return documentSummary(document);
    }
  }

  async function findOwnedUpload(req: Request<{ id: string }>): Promise<PendingUpload> {
    const session = currentSession(req);
    if (!UUID_PATTERN.test(req.params.id)) {
      throw notFound();
    }
    const upload = await uploads.findByOwner(session.userId, req.params.id);
    if (!upload) {
      throw notFound();
    }
    return upload;
  }

  return router;
}

function parseUploadRequest(body: unknown, maxUploadBytes: number, limitLabel: string): UploadRequest {
  const invalid = () => new HttpError(400, "invalid_upload", "The upload details are not valid.");
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid();
  }
  const fields = body as Record<string, unknown>;

  const kind = kindSchema.safeParse(fields.kind);
  if (!kind.success) {
    throw new HttpError(400, "invalid_kind", "Choose a document type.");
  }
  const { size, contentType, fileName, checksumSha256 } = fields;
  if (size === 0) {
    throw new HttpError(400, "empty_file", "The file is empty.");
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw invalid();
  }
  if (size > maxUploadBytes) {
    throw new HttpError(413, "file_too_large", `Files must be ${limitLabel} or smaller.`);
  }
  if (!isImageType(contentType)) {
    throw new HttpError(415, "unsupported_file_type", "Upload a JPEG, PNG or WebP image.");
  }
  if (typeof fileName !== "string" || fileName.length > MAX_FILE_NAME_INPUT_LENGTH) {
    throw invalid();
  }
  if (typeof checksumSha256 !== "string" || !SHA256_BASE64_PATTERN.test(checksumSha256)) {
    throw invalid();
  }
  return { kind: kind.data, fileName, size, contentType, checksumSha256 };
}

function uploadInProgress(): HttpError {
  return new HttpError(409, "upload_in_progress", "This upload is already being processed.");
}

function completionDeadline(upload: PendingUpload): number {
  return Date.parse(upload.expiresAt) + COMPLETION_GRACE_MS;
}

function documentFields({ id, userId, kind, fileName }: PendingUpload) {
  return { id, userId, kind, fileName, createdAt: new Date().toISOString() };
}
