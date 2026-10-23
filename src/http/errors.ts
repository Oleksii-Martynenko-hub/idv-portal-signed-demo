import type { ErrorRequestHandler, RequestHandler } from "express";

export interface ErrorBody {
  error: { code: string; message: string };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

export function notFound(): HttpError {
  return new HttpError(404, "not_found", "Not found.");
}

export function storageUnavailable(cause?: unknown): HttpError {
  const message = "File storage is temporarily unavailable. Try again later.";
  return new HttpError(502, "storage_unavailable", message, { cause });
}

// S3 and the signer are dependencies of this service; their failures are a 502, not a 500.
export async function viaStorage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw storageUnavailable(error);
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(errorBody("not_found", "Not found."));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  res.type("json");
  if (error instanceof HttpError) {
    if (error.status >= 500) {
      req.log.error({ err: error }, "request failed");
    }
    res.status(error.status).json(errorBody(error.code, error.message));
    return;
  }
  const client = asClientError(error);
  if (client) {
    res.status(client.status).json(errorBody(client.code, client.message));
    return;
  }
  req.log.error({ err: error }, "request failed");
  res.status(500).json(errorBody("internal_error", "Something went wrong. Try again later."));
};

// Shape used by body-parser and other http-errors based middleware.
interface ClientErrorFields {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  type?: unknown;
  message?: unknown;
}

function asClientError(error: unknown): { status: number; code: string; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode, expose, type, message } = error as ClientErrorFields;
  const resolved = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
  if (resolved === undefined || resolved < 400 || resolved >= 500) return undefined;
  return {
    status: resolved,
    code: clientErrorCode(resolved, type),
    message: expose === true && typeof message === "string" ? message : "The request could not be processed.",
  };
}

function clientErrorCode(status: number, type: unknown): string {
  if (type === "entity.parse.failed") return "invalid_json";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  return "bad_request";
}
