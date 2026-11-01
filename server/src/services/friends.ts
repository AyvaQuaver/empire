import { withTx } from "../db.js";
import type { DB } from "../db.js";
import { AppError, ERR } from "../errors.js";
import { validateUsername } from "../validation.js";
import { requireUser } from "./authService.js";

// Friends: exact-username lookup with rate limits (route level), email never
// returned. Requests prevent self-requests and duplicates/crossed pairs via
// canonical friendship rows.
//
// Room invitations go ONLY to accepted friends, through an in-app list that is
// recipient-scoped. A guest cannot use friend features.

export interface FriendView {
  userId: string;
  username: string;
}

function canonicalPair(a: string, b: string): [string, string] {
  const pair: [string, string] = a < b ? [a, b] : [b, a];
  return pair;
}

export function friendsOf(db: DB, sessionId: string): FriendView[] {
  const user = requireUser(db, sessionId);
  const rows = db
    .prepare(
      `SELECT u.id, u.username FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
        WHERE f.user_low = ? OR f.user_high = ?
        ORDER BY u.username`,
    )
    .all(user.id, user.id, user.id) as { id: string; username: string }[];
  return rows.map((r) => ({ userId: r.id, username: r.username }));
}

// Exact-username search: neutral found/not-found, no emails, no fuzzy matching.
export function searchUsername(db: DB, sessionId: string, raw: string): { found: boolean; userId?: string; username?: string } {
  const user = requireUser(db, sessionId);
  const v = validateUsername(raw);
  if (!v.ok) return { found: false };
  const row = db
    .prepare("SELECT id, username FROM users WHERE username_canonical = ?")
    .get(v.normalized) as { id: string; username: string } | undefined;
  if (!row || row.id === user.id) return { found: false };
  return { found: true, userId: row.id, username: row.username };
}

export function sendFriendRequest(db: DB, sessionId: string, targetUserId: string): void {
  const user = requireUser(db, sessionId);
  if (targetUserId === user.id) {
    throw new AppError(ERR.VALIDATION, 400, "You can't add yourself as a friend.");
  }
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetUserId);
  if (!target) throw new AppError(ERR.NOT_FOUND, 404, "No player found with that username.");
  withTx(db, () => {
    const [low, high] = canonicalPair(user.id, targetUserId);
    const already = db.prepare("SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ?").get(low, high);
    if (already) throw new AppError(ERR.CONFLICT, 409, "You're already friends with this player.");
    // Crossed request: if they've asked you, accept it into a friendship immediately.
    const crossed = db
      .prepare("SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?")
      .get(targetUserId, user.id);
    if (crossed) {
      db.prepare("DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?").run(
        targetUserId,
        user.id,
      );
      db.prepare("INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").run(
        low,
        high,
        Date.now(),
      );
      return;
    }
    if (db.prepare("SELECT 1 FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?").get(
      user.id,
      targetUserId,
    )) {
      throw new AppError(ERR.CONFLICT, 409, "You've already sent this friend request.");
    }
    db.prepare("INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)").run(
      user.id,
      targetUserId,
      Date.now(),
    );
  });
}

export function respondFriendRequest(db: DB, sessionId: string, requestId: number, accept: boolean): void {
  const user = requireUser(db, sessionId);
  withTx(db, () => {
    const row = db
      .prepare("SELECT * FROM friend_requests WHERE id = ?")
      .get(requestId) as { id: number; from_user_id: string; to_user_id: string } | undefined;
    if (!row || row.to_user_id !== user.id) {
      throw new AppError(ERR.NOT_FOUND, 404, "That friend request isn't available.");
    }
    db.prepare("DELETE FROM friend_requests WHERE id = ?").run(requestId);
    if (accept) {
      const [low, high] = canonicalPair(row.from_user_id, user.id);
      db.prepare("INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").run(
        low,
        high,
        Date.now(),
      );
    }
  });
}

export function cancelFriendRequest(db: DB, sessionId: string, requestId: number): void {
  const user = requireUser(db, sessionId);
  const row = db
    .prepare("SELECT id, from_user_id FROM friend_requests WHERE id = ?")
    .get(requestId) as { id: number; from_user_id: string } | undefined;
  if (!row || row.from_user_id !== user.id) {
    throw new AppError(ERR.NOT_FOUND, 404, "That friend request isn't available.");
  }
  db.prepare("DELETE FROM friend_requests WHERE id = ?").run(requestId);
}

export function removeFriend(db: DB, sessionId: string, otherUserId: string): void {
  const user = requireUser(db, sessionId);
  const [low, high] = canonicalPair(user.id, otherUserId);
  db.prepare("DELETE FROM friendships WHERE user_low = ? AND user_high = ?").run(low, high);
}

export interface RequestView {
  id: number;
  direction: "incoming" | "outgoing";
  username: string;
}

export function friendRequestsFor(db: DB, sessionId: string): RequestView[] {
  const user = requireUser(db, sessionId);
  const incoming = db
    .prepare(
      "SELECT fr.id, fr.from_user_id AS other, u.username FROM friend_requests fr JOIN users u ON u.id = fr.from_user_id WHERE fr.to_user_id = ?",
    )
    .all(user.id) as { id: number; other: string; username: string }[];
  const outgoing = db
    .prepare(
      "SELECT fr.id, fr.to_user_id AS other, u.username FROM friend_requests fr JOIN users u ON u.id = fr.to_user_id WHERE fr.from_user_id = ?",
    )
    .all(user.id) as { id: number; other: string; username: string }[];
  return [
    ...incoming.map((r) => ({ id: r.id, direction: "incoming" as const, username: r.username })),
    ...outgoing.map((r) => ({ id: r.id, direction: "outgoing" as const, username: r.username })),
  ];
}

// ---- In-app game invitations (accepted friends only) ----

export interface RoomInviteRow {
  id: number;
  room_id: string;
  room_code: string;
  title: string;
  from_name: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}

export function sendRoomInvite(
  db: DB,
  room: { id: string; state: string; current_round_id: string | null },
  fromPlayer: { id: string },
  fromUserId: string,
  inviteeUserId: string,
): void {
  if (room.state !== "open") throw new AppError(ERR.STATE, 409, "This game isn't open for invitations.");
  const roundId = room.current_round_id;
  const openRound = roundId
    ? (db.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as { state: string } | undefined)
    : undefined;
  if (!openRound || openRound.state !== "lobby_open") {
    throw new AppError(ERR.LOCKED, 409, "The room is locked. Invite friends for the next round.");
  }
  const pairLow = fromUserId < inviteeUserId ? fromUserId : inviteeUserId;
  const pairHigh = fromUserId < inviteeUserId ? inviteeUserId : fromUserId;
  const isFriend =
    db.prepare("SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ?").get(pairLow, pairHigh) !==
    undefined;
  if (!isFriend) {
    throw new AppError(ERR.FORBIDDEN, 403, "You can only invite friends through the in-app list.");
  }
  const invitee = db.prepare("SELECT id FROM users WHERE id = ?").get(inviteeUserId);
  if (!invitee) throw new AppError(ERR.NOT_FOUND, 404, "No player found with that username.");
  withTx(db, () => {
    db.prepare("INSERT OR IGNORE INTO room_invites (room_id, from_player_id, from_user_id, to_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      room.id,
      fromPlayer.id,
      fromUserId,
      inviteeUserId,
      Date.now(),
      Date.now() + INVITE_TTL_MS,
    );
  });
}

const INVITE_TTL_MS = 48 * 3600 * 1000;

// Invitations are recipient-scoped: this query never returns another user's invites.
export function invitesForUser(db: DB, sessionId: string): RoomInviteRow[] {
  const user = requireUser(db, sessionId);
  const rows = db
    .prepare(
      `SELECT i.id, i.room_id, i.room_id AS room_id, rm.code AS room_code, rm.title, rm.genre,
              fr.display_name AS from_name, i.created_at, i.expires_at, i.accepted_at
         FROM room_invites i
         JOIN rooms rm ON rm.id = i.room_id
         JOIN players fr ON fr.id = i.from_player_id
        WHERE i.to_user_id = ?
        ORDER BY i.created_at DESC`,
    )
    .all(user.id) as {
    id: number;
    room_id: string;
    room_code: string;
    title: string;
    genre: string;
    from_name: string;
    created_at: number;
    expires_at: number;
    accepted_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    room_id: r.room_id,
    room_code: r.room_code,
    title: r.title,
    from_name: r.from_name,
    created_at: r.created_at,
    expires_at: r.expires_at,
    accepted_at: r.accepted_at,
  }));
}

// Accepting only marks the invite accepted and returns the room code for a join
// link; joining still goes through the normal join endpoint, which enforces
// roster lock/expiry at accept time.
export function acceptRoomInvite(db: DB, sessionId: string, inviteId: number): { roomCode: string } {
  const user = requireUser(db, sessionId);
  return withTx(db, () => {
    const row = db.prepare("SELECT * FROM room_invites WHERE id = ?").get(inviteId) as
      | { id: number; room_id: string; to_user_id: string; created_at: number; expires_at: number; accepted_at: number | null }
      | undefined;
    if (!row || row.to_user_id !== user.id) {
      throw new AppError(ERR.NOT_FOUND, 404, "That invitation isn't available.");
    }
    if (row.accepted_at) {
      const room = db.prepare("SELECT code FROM rooms WHERE id = ?").get(row.room_id) as
        | { code: string }
        | undefined;
      return { roomCode: room ? room.code : "" };
    }
    if (row.expires_at < Date.now()) {
      throw new AppError(ERR.EXPIRED, 410, "That invitation has expired.");
    }
    const room = db.prepare("SELECT code, state FROM rooms WHERE id = ?").get(row.room_id) as
      | { code: string; state: string }
      | undefined;
    if (!room || room.state !== "open") {
      throw new AppError(ERR.EXPIRED, 410, "That game is no longer open.");
    }
    db.prepare("UPDATE room_invites SET accepted_at = ? WHERE id = ?").run(Date.now(), row.id);
    return { roomCode: room.code };
  });
}

export { friendRequestsFor as listFriendRequests };
