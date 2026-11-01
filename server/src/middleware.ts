import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { DB } from "./db.js";
import { sha256 } from "./ids.js";
import { AppError, ERR } from "./errors.js";

export const SESSION_COOKIE = "empire_sid";

export interface SessionInfo {
  // SHA-256 hash of the opaque session token; the raw token exists only in the cookie.
  id: string;
  user_id: string | null;
}

export interface AuthedRequest extends Request {
  session: SessionInfo | null;
}

export function sessionCookieAttrs(req: Request): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge?: number;
} {
  // 90-day refresh keeps the cookie session-only while the DB session row is the truth.
  const isHttps = (req.protocol === "https" || req.headers["x-forwarded-proto"] === "https");
  return { httpOnly: true, sameSite: "lax", secure: isHttps, path: "/", maxAge: 90 * 24 * 3600 * 1000 };
}

export function readSession(db: DB, req: Request): SessionInfo | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const id = sha256(token);
  const row = db.prepare("SELECT id, user_id FROM sessions WHERE id = ?").get(id) as
    | { id: string; user_id: string | null }
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  return { id: row.id, user_id: row.user_id };
}

export function setSessionCookie(db: DB, res: Response, req: Request, userId: string | null): void {
  // Insert a fresh unhashed token; we store only its hash.
  const token = crypto.randomBytes(32).toString("base64url");
  const id = sha256(token);
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, now, now);
  res.cookie(SESSION_COOKIE, token, sessionCookieAttrs(req));
}

export function clearSessionCookie(res: Response, req: Request): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieAttrs(req));
}

export function sessionMiddleware(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    let session = readSession(db, req);
    if (!session) {
      // Issue a guest session for fresh browsers: guests need no account to play.
      const token = crypto.randomBytes(32).toString("base64url");
      const id = sha256(token);
      const now = Date.now();
      db.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, NULL, ?, ?)").run(
        id,
        now,
        now,
      );
      res.cookie(SESSION_COOKIE, token, sessionCookieAttrs(req));
      session = { id, user_id: null };
    }
    (req as AuthedRequest).session = session;
    next();
  };
}

export function requireSession(req: Request): SessionInfo {
  const s = (req as AuthedRequest).session;
  if (!s) throw new AppError(ERR.UNAUTHENTICATED, 401, "Please sign in again.");
  // Periodic sliding refresh of last_seen already updated in readSession.
  return s;
}

// CSRF protection: SameSite=Lax cookies plus a required custom header on
// mutating requests (another origin cannot send this header cross-site without CORS).
export function csrfCheck(req: Request, _res: Response, next: NextFunction): void {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    if (req.get("x-empire-with") !== "fetch") {
      next(new AppError(ERR.FORBIDDEN, 403, "Invalid request origin."));
      return;
    }
  }
  next();
}
