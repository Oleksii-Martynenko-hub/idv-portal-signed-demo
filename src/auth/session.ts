import { createHash, randomBytes } from "node:crypto";
import { parseCookie, stringifySetCookie } from "cookie";
import type { Request, RequestHandler } from "express";
import { HttpError } from "../http/errors.js";
import type { Session, SessionRepository } from "./repository.js";

export const SESSION_COOKIE = "sid";

const TOKEN_BYTES = 32;
// 32 random bytes encode to 43 base64url characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

declare global {
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

// Only the hash is stored, so a copy of the table does not yield usable cookies.
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionCookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

export function serializeSessionCookie(token: string, { maxAgeSeconds, secure }: SessionCookieOptions): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
    secure,
  });
}

export function clearSessionCookie({ secure }: Pick<SessionCookieOptions, "secure">): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
    secure,
  });
}

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const token = parseCookie(cookieHeader)[SESSION_COOKIE];
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : undefined;
}

// Attaches req.session when the cookie carries a live session; never rejects.
export function resolveSession(sessions: SessionRepository): RequestHandler {
  return async (req, _res, next) => {
    const token = readSessionToken(req.headers.cookie);
    if (token) {
      const session = await sessions.findByTokenHash(hashSessionToken(token));
      if (session && Date.parse(session.expiresAt) > Date.now()) {
        req.session = session;
      }
    }
    next();
  };
}

export function currentSession(req: Request): Session {
  if (!req.session) {
    throw new HttpError(401, "unauthenticated", "Sign in to continue.");
  }
  return req.session;
}

export const requireSession: RequestHandler = (req, _res, next) => {
  currentSession(req);
  next();
};
