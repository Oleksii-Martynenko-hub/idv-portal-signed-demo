import type { Logger } from "pino";
import type { UrlSigner } from "../storage/presigner.js";
import { contentDisposition } from "./file-name.js";
import { fileKeyFor } from "./keys.js";
import type { DocumentKind, DocumentRecord } from "./repository.js";

export interface DocumentView {
  id: string;
  kind: DocumentKind;
  fileName: string;
  contentType: string;
  size: number;
  status: DocumentRecord["status"];
  createdAt: string;
  url?: string;
  urlExpiresAt?: string;
  rejectionReason?: string;
}

export type DocumentPresenter = (document: DocumentRecord, ownerId: string, log: Logger) => Promise<DocumentView>;

// The fields every document shows, without a read URL or a reason.
export function documentSummary(document: DocumentRecord): DocumentView {
  const { id, kind, fileName, contentType, size, status, createdAt } = document;
  return { id, kind, fileName, contentType, size, status, createdAt };
}

// Received documents get a short-lived read URL for their promoted object.
export function documentPresenter(signer: UrlSigner, urlTtlSeconds: number): DocumentPresenter {
  return async (document, ownerId, log) => {
    const { id, fileName, contentType } = document;
    const view = documentSummary(document);
    if (document.status === "rejected") {
      return { ...view, rejectionReason: document.rejectionReason };
    }

    // The key is rebuilt from the session, so a bad record can never point a URL at another object.
    const key = fileKeyFor(ownerId, id);
    if (document.s3Key !== key) {
      log.error({ documentId: id }, "stored object key is not where this service keeps the file; no read URL issued");
      return view;
    }
    const { url, expiresAt } = await signer.presignDownload({
      key,
      contentType,
      contentDisposition: contentDisposition(fileName),
      expiresInSeconds: urlTtlSeconds,
    });
    return { ...view, url, urlExpiresAt: expiresAt.toISOString() };
  };
}
