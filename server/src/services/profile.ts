import { AppError, ERR } from "../errors.js";
import { normalizeText } from "../validation.js";
import { GAME } from "../config.js";
import { sha256 } from "../ids.js";
import type { DB } from "../db.js";

/* Account profile: the PUBLIC, editable display name is decoupled from the
 * sign-in username (canonical, unique, credential). Avatar colours are
 * persisted palette KEYS so an initial renders identically on every device. */

const DISPLAY_NAME_MAX = GAME.displayNameMax; // 24, shared with lobby naming

export interface AvatarPaletteEntry {
  bg: string;
  fg: string;
}

export const AVATAR_PALETTE: Record<string, AvatarPaletteEntry> = {
  coral: { bg: "#F0503B", fg: "#29143F" },
  grape: { bg: "#7B3F9E", fg: "#FFF9ED" },
  lavender: { bg: "#C7ADFF", fg: "#29143F" },
  peach: { bg: "#FF684F", fg: "#29143F" },
  ink: { bg: "#29143F", fg: "#C7ADFF" },
  plum: { bg: "#4B226E", fg: "#FFF9ED" },
};

export const AVATAR_PALETTE_KEYS = Object.keys(AVATAR_PALETTE);

/** Deterministic palette key from the account id: assigned once, then the DB
 * keeps it stable across refreshes and devices. */
export function defaultAvatarColor(userId: string): string {
  const digest = sha256(`avatar:${userId}`);
  const index = parseInt(digest.slice(0, 8), 16) % AVATAR_PALETTE_KEYS.length;
  return AVATAR_PALETTE_KEYS[index];
}

export interface ProfileView {
  displayName: string;
  avatarColor: string;
}

/** The effective profile for an account row: display name falls back to the
 * username for rows predating migration 0006; a missing avatar colour is
 * assigned once and persisted. */
export function ensureProfile(db: DB, user: { id: string; username: string; display_name?: string | null; avatar_color?: string | null }): ProfileView {
  const displayName = user.display_name && user.display_name.trim() !== "" ? user.display_name : user.username;
  let avatarColor = user.avatar_color && AVATAR_PALETTE_KEYS.includes(user.avatar_color) ? user.avatar_color : null;
  if (!avatarColor) {
    avatarColor = defaultAvatarColor(user.id);
    db.prepare("UPDATE users SET avatar_color = ? WHERE id = ? AND avatar_color IS NULL").run(avatarColor, user.id);
  }
  return { displayName, avatarColor };
}

const CONTROL_OR_EMPTY = /^[\s\u0000-\u001f\u007f-\u009f]*$/u;

/** Validate an edited display name: trimmed, short, no control characters,
 * must contain at least one real letter (so "???" or whitespace-only is
 * rejected) while allowing normal international names. */
export function validateDisplayName(value: unknown): { ok: true; display: string } | { ok: false; message: string } {
  const base = normalizeText(value, DISPLAY_NAME_MAX, "displayName");
  if (!base.ok) return { ok: false, message: base.message };
  if (CONTROL_OR_EMPTY.test(base.display)) return { ok: false, message: "Please fill in this field." };
  if (!/\p{L}/u.test(base.display)) {
    return { ok: false, message: "Use at least one letter (punctuation alone won't do)." };
  }
  if (base.display.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Keep this under ${DISPLAY_NAME_MAX} characters.` };
  }
  return { ok: true, display: base.display };
}

/** Rename ONLY the caller's account; username/email/credentials are untouched. */
export function updateDisplayName(db: DB, userId: string, value: unknown): ProfileView {
  const user = db
    .prepare("SELECT id, username, display_name, avatar_color FROM users WHERE id = ?")
    .get(userId) as { id: string; username: string; display_name: string | null; avatar_color: string | null } | undefined;
  if (!user) throw new AppError(ERR.NOT_FOUND, 404, "Sign in again.");
  const check = validateDisplayName(value);
  if (!check.ok) throw new AppError(ERR.VALIDATION, 400, check.message, { field: "displayName" });
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(check.display, user.id);
  return { displayName: check.display, avatarColor: ensureProfile(db, { ...user, display_name: check.display }).avatarColor };
}
