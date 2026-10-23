import { type Request, Router } from "express";
import { currentSession } from "../auth/session.js";
import { notFound, viaStorage } from "../http/errors.js";
import type { ObjectStore } from "../storage/s3.js";
import { fileKeyFor } from "./keys.js";
import type { DocumentRecord, DocumentRepository } from "./repository.js";
import type { DocumentPresenter } from "./view.js";

export interface DocumentsDependencies {
  documents: DocumentRepository;
  store: ObjectStore;
  presentDocument: DocumentPresenter;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function documentsRouter({ documents, store, presentDocument }: DocumentsDependencies): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const session = currentSession(req);
    const list = await documents.listByOwner(session.userId);
    const views = await viaStorage(
      Promise.all(list.map((document) => presentDocument(document, session.userId, req.log))),
    );
    res.json({ documents: views });
  });

  // The record goes only after its object, since nothing else points at it. Only the key
  // rebuilt from the session is ever deleted.
  router.delete("/:id", async (req, res) => {
    const session = currentSession(req);
    const document = await findOwned(req);
    const key = fileKeyFor(session.userId, document.id);
    if (document.status === "received") {
      if (document.s3Key !== key) {
        throw new Error(
          `Document ${document.id}: the stored object key is not where this service keeps the file; nothing deleted`,
        );
      }
      await viaStorage(store.delete(key));
    } else {
      // A rejected document has no object, unless a failed completion left its copy behind.
      try {
        await store.delete(key);
      } catch (error) {
        req.log.error({ err: error, key }, "could not remove a promoted object of a rejected document");
      }
    }
    await documents.delete(session.userId, document.id);
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
