import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Config } from "../config.js";
import { errorBody, HttpError } from "../http/errors.js";
import { emailSchema } from "../users/email.js";
import type { UserRepository } from "../users/repository.js";
import type { SessionRepository } from "./repository.js";
import {
  clearSessionCookie,
  currentSession,
  generateSessionToken,
  hashSessionToken,
  resolveSession,
  serializeSessionCookie,
} from "./session.js";

export interface AuthDependencies {
  users: UserRepository;
  sessions: SessionRepository;
  config: Pick<Config, "isProduction" | "sessionTtlSeconds">;
}

const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
const SIGN_IN_LIMIT = 20;

const signInSchema = z.object({ email: emailSchema });

export function authRouter({ users, sessions, config }: AuthDependencies): Router {
  const router = Router();
  const withSession = resolveSession(sessions);

  const signInLimiter = rateLimit({
    windowMs: SIGN_IN_WINDOW_MS,
    limit: SIGN_IN_LIMIT,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json(errorBody("too_many_requests", "Too many sign-in attempts. Try again later."));
    },
  });

  router.post("/sign-in", signInLimiter, express.json({ limit: "10kb" }), withSession, async (req, res) => {
    const parsed = signInSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "invalid_email", "Enter a valid email address.");
    }

    const user = await users.findOrCreate(parsed.data.email);
    // A browser that still holds a session gets a fresh one; the old cookie stops working.
    if (req.session) {
      await sessions.delete(req.session.tokenHash);
    }
    const token = generateSessionToken();
    await sessions.create({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      ttlSeconds: config.sessionTtlSeconds,
    });

    res.setHeader(
      "Set-Cookie",
      serializeSessionCookie(token, { maxAgeSeconds: config.sessionTtlSeconds, secure: config.isProduction }),
    );
    res.status(204).end();
  });

  router.post("/sign-out", withSession, async (req, res) => {
    if (req.session) {
      await sessions.delete(req.session.tokenHash);
    }
    res.setHeader("Set-Cookie", clearSessionCookie({ secure: config.isProduction }));
    res.status(204).end();
  });

  return router;
}

// GET /api/me; expects the session to have been resolved and required already.
export function currentUserRouter({ users }: Pick<AuthDependencies, "users">): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const session = currentSession(req);
    const user = await users.findById(session.userId);
    if (!user) {
      throw new HttpError(401, "unauthenticated", "Sign in to continue.");
    }
    res.json({ id: user.id, email: user.email, createdAt: user.createdAt });
  });

  return router;
}
