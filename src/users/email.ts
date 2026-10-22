import { z } from "zod";

const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const emailSchema = z.string().transform(normalizeEmail).pipe(z.email().max(MAX_EMAIL_LENGTH));
