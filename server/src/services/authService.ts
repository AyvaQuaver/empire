import { withTx } from "../db.js";
import type { DB } from "../db.js";
import { AppError, ERR } from "../errors.js";
import { randomToken, sha256, randomId } from "../ids.js";
import { hashPassword, verifyPassword, dummyHashWork, getUser } from "../auth.js";
import { validateUsername, passwordStrength, normalizeText } from "../validation.js";
import { deliverEmail, passwordResetEmailContent, verificationEmailContent } from "../email.js";
import { config } from "../config.js";

const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

export interface UserView {
  id: string;
  username: string;
  emailVerified: boolean;
}

function userView(
  row: { id: string; username: string; email_verified_at: number | null },
): UserView {
  return { id: row.id, username: row.username, emailVerified: row.email_verified_at !== null };
}

export function requireUser(db: DB, sessionId: string): { id: string; username: string; email_verified_at: number | null } {
  const row = db
    .prepare(
      "SELECT u.id, u.username, u.email_verified_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    )
    .get(sessionId) as { id: string; username: string; email_verified_at: number | null } | undefined;
  if (!row) throw new AppError(ERR.UNAUTHENTICATED, 401, "Sign in to use that feature.");
  return row;
}

function issueToken(db: DB, userId: string, kind: "verify_email" | "password_reset", ttlMs: number): string {
  const token = randomToken(24);
  db.prepare("INSERT INTO email_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    kind,
    sha256(token),
    Date.now() + ttlMs,
    Date.now(),
  );
  return token;
}

// Register a new account. If the caller is an authenticated guest session, the
// CURRENT guest session is upgraded to the new account: room memberships bound
// to this session follow it, and nothing belonging to any other session is claimed.
export async function register(
  db: DB,
  sessionId: string,
  input: { username: string; email: string; password: string },
): Promise<UserView> {
  const username = validateUsername(input.username);
  if (!username.ok) throw new AppError(username.code, 400, username.message, { field: username.field });
  const email = normalizeText(input.email, 200, "email");
  if (!email.ok || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.display)) {
    throw new AppError(ERR.VALIDATION, 400, "Enter a valid email address.", { field: "email" });
  }
  const password = passwordStrength(input.password);
  if (!password.ok) throw new AppError(password.code, 400, password.message, { field: password.field });

  const hash = await hashPassword(password.display);
  const created = withTx(db, () => {
    if (db.prepare("SELECT 1 FROM users WHERE username_canonical = ?").get(username.normalized)) {
      throw new AppError(ERR.USERNAME_TAKEN, 409, "That username is taken. Try another.", { field: "username" });
    }
    if (db.prepare("SELECT 1 FROM users WHERE email_canonical = ?").get(email.normalized)) {
      throw new AppError(ERR.EMAIL_TAKEN, 409, "An account with that email already exists.", { field: "email" });
    }
    const id = randomId();
    db.prepare(
      "INSERT INTO users (id, username, username_canonical, email, email_canonical, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, username.display, username.normalized, email.display, email.normalized, hash, Date.now());

    // Upgrade the guest session: memberships survive because players.session_id unchanged.
    db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").run(id, sessionId);
    // Rebind players owned by this session so history follows the account
    // (only THIS session's players — no one else's history is claimed).
    db.prepare("UPDATE players SET user_id = ? WHERE session_id = ? AND user_id IS NULL").run(id, sessionId);

    const verifyToken = issueToken(db, id, "verify_email", VERIFY_TTL_MS);
    return { id, email: email.display, verifyToken };
  });
  try {
    const { subject, body } = verificationEmailContent(
      `${config.appBaseUrl}/verify-email?token=${created.verifyToken}`,
    );
    await deliverEmail(db, { to: created.email, subject, body });
  } catch {
    // Registration succeeded; the verification email can be resent later.
  }
  const user = getUser(db, created.id);
  return userView(user as NonNullable<typeof user>);
}

export function verifyEmail(db: DB, token: string): void {
  withTx(db, () => {
    const row = db
      .prepare(
        "SELECT * FROM email_tokens WHERE token_hash = ? AND kind = 'verify_email' AND used_at IS NULL AND expires_at > ?",
      )
      .get(sha256(token), Date.now()) as { id: number; user_id: string } | undefined;
    if (!row) throw new AppError(ERR.INVALID_TOKEN, 400, "That verification link has expired. Try resending it.");
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
    db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL").run(
      Date.now(),
      row.user_id,
    );
  });
}

export async function resendVerification(db: DB, sessionId: string): Promise<void> {
  const user = requireUser(db, sessionId);
  if (user.email_verified_at) throw new AppError(ERR.STATE, 409, "Your email is already verified.");
  const recent = db
    .prepare(
      "SELECT 1 FROM email_tokens WHERE user_id = ? AND created_at > ? AND used_at IS NULL AND kind = 'verify_email'",
    )
    .get(user.id, Date.now() - RESEND_COOLDOWN_MS);
  if (recent) {
    throw new AppError(ERR.RATE_LIMITED, 429, "Please wait a couple of minutes before requesting another email.");
  }
  const row = db
    .prepare("SELECT id, username, username_canonical, email, email_canonical, email_verified_at, created_at FROM users WHERE id = ?")
    .get(user.id) as { id: string; username: string; username_canonical: string; email: string; email_canonical: string; email_verified_at: number | null; created_at: number } | undefined;
  if (!row) throw new AppError(ERR.UNAUTHENTICATED, 401, "Sign in again.");
  const token = randomToken(24);
  const expiresAt = Date.now() + VERIFY_TTL_MS;
  db.prepare(
    "INSERT INTO email_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?, 'verify_email', ?, ?, ?)",
  ).run(user.id, sha256(token), expiresAt, Date.now());
  const content = verificationEmailContent(`${config.appBaseUrl}/verify-email?token=${token}`);
  try {
    await deliverEmail(db, { to: row.email, subject: content.subject, body: content.body });
  } catch {
    throw new AppError(ERR.EMAIL_FAILED, 502, "We couldn't send the email right now. Please try again shortly.");
  }
}

// Sign in binds the credentials to a FRESH session; the previous guest session
// (and its room memberships) remains untouched so a shared device cannot merge
// identities. Returns the new user id for the route to set the cookie with.
export async function signIn(
  db: DB,
  input: { username: string; password: string },
): Promise<{ userId: string }> {
  const usernameNormalized = validateUsername(input.username);
  if (!usernameNormalized.ok) {
    // Validate shape, but respond with a generic credential error (no enumeration).
    await dummyHashWork();
    throw new AppError(ERR.INVALID_CREDENTIALS, 401, "That username or password isn't right.");
  }
  const row = db
    .prepare(
      "SELECT id, username, username_canonical, email, email_canonical, email_verified_at, created_at, password_hash FROM users WHERE username_canonical = ?",
    )
    .get(usernameNormalized.normalized) as
    | ({ password_hash: string } & { id: string; username: string; username_canonical: string; email: string; email_canonical: string; email_verified_at: number | null; created_at: number })
    | undefined;
  if (!row) {
    await dummyHashWork();
    throw new AppError(ERR.INVALID_CREDENTIALS, 401, "That username or password isn't right.");
  }
  const ok = await verifyPassword(input.password, row.password_hash);
  if (!ok) throw new AppError(ERR.INVALID_CREDENTIALS, 401, "That username or password isn't right.");
  return { userId: row.id };
}

export async function forgotPassword(db: DB, usernameOrEmail: string): Promise<void> {
  // Always responds the same way; tokens are only sent to the account on file.
  const canonical = String(usernameOrEmail || "").trim().toLowerCase();
  const row =
    (db
      .prepare("SELECT id, email FROM users WHERE username_canonical = ?")
      .get(canonical) as { id: string; email: string } | undefined) ??
    (db
      .prepare("SELECT id, email FROM users WHERE email_canonical = ?")
      .get(canonical) as { id: string; email: string } | undefined);
  if (row) {
    const token = issueToken(db, row.id, "password_reset", RESET_TTL_MS);
    const content = passwordResetEmailContent(`${config.appBaseUrl}/reset-password?token=${token}`);
    try {
      await deliverEmail(db, { to: row.email, subject: content.subject, body: content.body });
    } catch {
      // fall through: response is identical either way
    }
  } else {
    await dummyHashWork();
  }
}

export async function resetPassword(
  db: DB,
  token: string,
  newPassword: string,
): Promise<void> {
  const strength = passwordStrength(newPassword);
  if (!strength.ok) throw new AppError(strength.code, 400, strength.message, { field: "password" });
  const hash = await hashPassword(newPassword);
  withTx(db, () => {
    const row = db
      .prepare(
        "SELECT * FROM email_tokens WHERE token_hash = ? AND kind = 'password_reset' AND used_at IS NULL AND expires_at > ?",
      )
      .get(sha256(token), Date.now()) as { id: number; user_id: string } | undefined;
    if (!row) throw new AppError(ERR.INVALID_TOKEN, 400, "That reset link has expired. Request a new one.");
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.user_id);
    // Invalidate every session for safety after a password reset.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  });
}

export function signOutSession(db: DB, sessionId: string): void {
  withTx(db, () => {
    // Deleting the session orphans memberships (players.session_id becomes NULL):
    // the roster stays intact; nobody else gains that identity.
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  });
}

// Safe account deletion: requires the session to be signed in AND reauthentication.
// User rows and social bindings are removed; shared game history keeps non-secret
// participation records with the winner's display name (names are not account data).
export function deleteAccount(db: DB, sessionId: string): void {
  const user = requireUser(db, sessionId);
  withTx(db, () => {
    const uid = user.id;
    // Unbind player memberships so historical entries survive with display names only.
    db.prepare("UPDATE players SET user_id = NULL WHERE user_id = ?").run(uid);
    db.prepare("UPDATE game_results SET winner_user_id = NULL, recorded_by_user_id = NULL WHERE winner_user_id = ? OR recorded_by_user_id = ?").run(uid, uid);
    db.prepare("UPDATE result_audit SET new_winner_user_id = NULL, previous_winner_user_id = NULL, changed_by_user_id = NULL WHERE new_winner_user_id = ? OR previous_winner_user_id = ? OR changed_by_user_id = ?").run(uid, uid, uid);
    db.prepare("UPDATE room_invites SET from_user_id = NULL WHERE from_user_id = ?").run(uid);
    db.prepare("DELETE FROM friendships WHERE user_low = ? OR user_high = ?").run(uid, uid);
    db.prepare("DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?").run(uid, uid);
    db.prepare("DELETE FROM room_invites WHERE to_user_id = ? OR from_user_id = ?").run(uid, uid);
    // The users row cascade deletes sessions, email tokens.
    db.prepare("DELETE FROM users WHERE id = ?").run(uid);
  });
}
