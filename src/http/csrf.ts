import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// State-changing requests must come from this origin. Modern browsers send
// Sec-Fetch-Site; older ones at least send Origin on cross-origin requests.
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const site = req.get("sec-fetch-site");
  const allowed =
    site !== undefined
      ? site === "same-origin" || site === "none"
      : originMatchesHost(req.get("origin"), req.host);

  if (allowed) {
    next();
  } else {
    next(new HttpError(403, "cross_site_request", "Cross-site requests are not allowed."));
  }
};

function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.host.toLowerCase() === host.toLowerCase();
}
