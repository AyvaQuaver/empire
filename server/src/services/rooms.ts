import type { DB } from "../db.js";
import { withTx } from "../db.js";
import { AppError, ERR } from "../errors.js";
import { randomCode, randomToken, randomId } from "../ids.js";
import { GAME } from "../config.js";
import { normalizeText } from "../validation.js";

// Rooms, membership, roster locking. Public membership data is kept separate
// from private submissions (which live only in private_* tables and are never
// returned by any function below).

export interface RoomRow {
  id: string;
  code: string;
  title: string;
  genre: string;
  state: string;
  organiser_player_id: string | null;
  invitation_token: string;
  current_round_id: string | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  locked_at: number | null;
}

export interface PlayerRow {
  id: string;
  room_id: string;
  session_id: string | null;
  user_id: string | null;
  display_name: string;
  display_name_canonical: string;
  join_order: number;
  is_organiser: number;
  status: string;
  created_at: number;
  last_seen_at: number;
}

export interface RoundRow {
  word_pause_ms: number | null;
  id: string;
  room_id: string;
  seq: number;
  state: string;
  genre: string;
  title: string;
  starter_player_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

export function getRoomByCode(db: DB, code: string): RoomRow | null {
  const row = db
    .prepare("SELECT * FROM rooms WHERE UPPER(code) = UPPER(?)")
    .get(String(code).trim().slice(0, 20)) as RoomRow | undefined;
  return row ?? null;
}

export function getRoomByInvitationToken(db: DB, token: string): RoomRow | null {
  const row = db
    .prepare("SELECT * FROM rooms WHERE invitation_token = ?")
    .get(String(token)) as RoomRow | undefined;
  return row ?? null;
}

export function getRoomById(db: DB, id: string): RoomRow | null {
  const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
  return row ?? null;
}

export function getRound(db: DB, roundId: string | null): RoundRow | null {
  if (!roundId) return null;
  const row = db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as RoundRow | undefined;
  return row ?? null;
}

export function activePlayers(db: DB, roomId: string): PlayerRow[] {
  return db
    .prepare("SELECT * FROM players WHERE room_id = ? AND status = 'active' ORDER BY join_order")
    .all(roomId) as unknown as PlayerRow[];
}

export function playerById(db: DB, id: string): PlayerRow | null {
  const row = db.prepare("SELECT * FROM players WHERE id = ?").get(id) as PlayerRow | undefined;
  return row ?? null;
}

// Membership is bound to the browser session, never to a client-supplied actor id.
export function findActivePlayerForSession(db: DB, roomId: string, sessionId: string): PlayerRow | null {
  const row = db
    .prepare("SELECT * FROM players WHERE room_id = ? AND session_id = ? AND status = 'active'")
    .get(roomId, sessionId) as PlayerRow | undefined;
  return row ?? null;
}

export function requireMember(db: DB, room: RoomRow, sessionId: string): PlayerRow {
  const player = findActivePlayerForSession(db, room.id, sessionId);
  if (!player) throw new AppError(ERR.FORBIDDEN, 403, "You're not a member of this room.");
  return player;
}

export function requireOrganiser(db: DB, room: RoomRow, sessionId: string): PlayerRow {
  const player = requireMember(db, room, sessionId);
  if (!player.is_organiser) throw new AppError(ERR.FORBIDDEN, 403, "Only the organiser can do that.");
  return player;
}

export function rosterCount(db: DB, roundId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM round_roster r JOIN players p ON p.id = r.player_id WHERE r.round_id = ? AND p.status = 'active'",
    )
    .get(roundId) as { n: number };
  return row.n;
}

export function rosterForRound(db: DB, roundId: string): PlayerRow[] {
  return db
    .prepare(
      "SELECT p.* FROM round_roster r JOIN players p ON p.id = r.player_id WHERE r.round_id = ? AND p.status = 'active' ORDER BY r.join_order",
    )
    .all(roundId) as unknown as PlayerRow[];
}

function insertRound(
  db: DB,
  roomId: string,
  seq: number,
  title: string,
  genre: string,
  state: string,
): RoundRow {
  const id = randomId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO rounds (id, room_id, seq, state, genre, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, roomId, seq, state, genre, title, now, now);
  return getRound(db, id) as RoundRow;
}

export function touchRoom(db: DB, roomId: string): void {
  const now = Date.now();
  db.prepare("UPDATE rooms SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(now, now, roomId);
}

export interface CreateRoomResult {
  room: RoomRow;
  player: PlayerRow;
  round: RoundRow;
  invitationToken: string;
}

export function createRoom(
  db: DB,
  sessionId: string,
  sessionUserId: string | null,
  input: { displayName: string; title?: string; genre: string },
): CreateRoomResult {
  const name = normalizeText(input.displayName, GAME.displayNameMax, "displayName");
  if (!name.ok) throw new AppError(name.code, 400, name.message, { field: name.field });
  const genre = normalizeText(input.genre, GAME.genreMax, "genre");
  if (!genre.ok) throw new AppError(genre.code, 400, genre.message, { field: genre.field });
  let title = input.title && input.title.trim() !== "" ? input.title : `${name.display}'s game`;
  const titleV = normalizeText(title, GAME.titleMax, "title");
  if (!titleV.ok) throw new AppError(titleV.code, 400, titleV.message, { field: titleV.field });
  title = titleV.display;

  return withTx(db, (): CreateRoomResult => {
    // Room code: retry on the (astronomically unlikely) collision.
    // The code identifies the room; it does NOT authorize access to private data.
    let code = "";
    for (let i = 0; i < 25; i++) {
      const candidate = randomCode();
      const clash = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(candidate);
      if (!clash) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new AppError(ERR.INTERNAL, 500, "Could not allocate a room code.");
    const invitationToken = randomToken(32);
    const now = Date.now();
    const roomId = randomId();
    db.prepare(
      "INSERT INTO rooms (id, code, title, genre, state, invitation_token, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    ).run(roomId, code, title, genre.display, invitationToken, now, now, now);

    const playerId = randomId();
    db.prepare(
      "INSERT INTO players (id, room_id, session_id, user_id, display_name, display_name_canonical, join_order, is_organiser, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'active', ?, ?)",
    ).run(playerId, roomId, sessionId, sessionUserId, name.display, name.normalized, now, now);
    db.prepare("UPDATE rooms SET organiser_player_id = ? WHERE id = ?").run(playerId, roomId);
    db.prepare("INSERT INTO next_round_roster (room_id, player_id) VALUES (?, ?)").run(roomId, playerId);

    const round = insertRound(db, roomId, 1, title, genre.display, "lobby_open");
    db.prepare("UPDATE rooms SET current_round_id = ? WHERE id = ?").run(round.id, roomId);
    const room = getRoomById(db, roomId) as RoomRow;
    const player = playerById(db, playerId) as PlayerRow;
    return { room, player, round, invitationToken };
  });
}

export interface JoinResult {
  room: RoomRow;
  player: PlayerRow;
  reconnected: boolean;
}

export function joinRoom(
  db: DB,
  sessionId: string,
  sessionUserId: string | null,
  input: { code?: string; invitationToken?: string; displayName: string },
): JoinResult {
  let room: RoomRow | null = null;
  if (input.invitationToken) {
    room = getRoomByInvitationToken(db, input.invitationToken);
    if (!room) throw new AppError(ERR.NOT_FOUND, 404, "That invite link isn't valid any more.");
  } else if (input.code) {
    room = getRoomByCode(db, input.code);
    if (!room) throw new AppError(ERR.NOT_FOUND, 404, "No game found with that code. Check it and try again.");
  } else {
    throw new AppError(ERR.VALIDATION, 400, "Enter a room code to join.");
  }

  const name = normalizeText(input.displayName, GAME.displayNameMax, "displayName");
  if (!name.ok) throw new AppError(name.code, 400, name.message, { field: name.field });

  return withTx(db, (): JoinResult => {
    if (room.state !== "open") {
      const stateMessage =
        room.state === "cancelled"
          ? "This game was cancelled."
          : "This game is no longer available.";
      throw new AppError(ERR.EXPIRED, 410, stateMessage);
    }
    // Idempotent rejoin: an active membership for this session is returned as-is.
    const existing = findActivePlayerForSession(db, room.id, sessionId);
    if (existing) {
      return { room, player: existing, reconnected: true };
    }

    const round = getRound(db, room.current_round_id);
    if (round && round.state !== "lobby_open") {
      throw new AppError(
        ERR.ROOM_STARTED,
        409,
        "This round has already started. Ask the organiser to invite you for the next round.",
      );
    }
    if (!round) {
      throw new AppError(ERR.STATE, 409, "This game isn't open for players yet.");
    }

    const active = activePlayers(db, room.id);
    if (active.length >= GAME.maxPlayers) {
      throw new AppError(ERR.ROOM_FULL, 409, `This game is full (${GAME.maxPlayers} players max).`);
    }
    const clash = db
      .prepare(
        "SELECT 1 FROM players WHERE room_id = ? AND display_name_canonical = ? AND status = 'active'",
      )
      .get(room.id, name.normalized);
    if (clash) {
      throw new AppError(ERR.NAME_TAKEN, 409, "That name is already taken in this room. Pick another.");
    }

    const joinOrder = active.length === 0 ? 1 : Math.max(...active.map((p) => p.join_order)) + 1;
    const now = Date.now();
    const playerId = randomId();
    db.prepare(
      "INSERT INTO players (id, room_id, session_id, user_id, display_name, display_name_canonical, join_order, is_organiser, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)",
    ).run(playerId, room.id, sessionId, sessionUserId, name.display, name.normalized, joinOrder, now, now);
    // While the round is open to joins, the joiner is part of the forming roster.
    db.prepare("INSERT OR IGNORE INTO next_round_roster (room_id, player_id) VALUES (?, ?)").run(
      room.id,
      playerId,
    );
    touchRoom(db, room.id);
    const player = playerById(db, playerId) as PlayerRow;
    return { room, player, reconnected: false };
  });
}

export function updateRoom(
  db: DB,
  sessionId: string,
  room: RoomRow,
  input: { genre?: string; title?: string },
): RoomRow {
  const organiser = requireOrganiser(db, room, sessionId);
  void organiser;
  const round = getRound(db, room.current_round_id);
  if (!round || round.state !== "lobby_open") {
    throw new AppError(ERR.LOCKED, 409, "The roster is locked, so details can't change until Play another round.");
  }
  return withTx(db, () => {
    if (typeof input.genre === "string") {
      const genre = normalizeText(input.genre, GAME.genreMax, "genre");
      if (!genre.ok) throw new AppError(genre.code, 400, genre.message, { field: genre.field });
      db.prepare("UPDATE rooms SET genre = ? WHERE id = ?").run(genre.display, room.id);
    }
    if (typeof input.title === "string" && input.title.trim() !== "") {
      const title = normalizeText(input.title, GAME.titleMax, "title");
      if (!title.ok) throw new AppError(title.code, 400, title.message, { field: title.field });
      db.prepare("UPDATE rooms SET title = ? WHERE id = ?").run(title.display, room.id);
    }
    touchRoom(db, room.id);
    return getRoomById(db, room.id) as RoomRow;
  });
}

// Lock the roster: moves the round from lobby_open to collecting_words.
// Roster = the confirmed next_round_roster members who are still active.
export function lockRoster(db: DB, sessionId: string, room: RoomRow): RoundRow {
  requireOrganiser(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round) throw new AppError(ERR.STATE, 409, "There is no round to lock.");
  if (round.state !== "lobby_open") {
    throw new AppError(ERR.LOCKED, 409, "The roster is already locked.");
  }
  return withTx(db, () => {
    const rosterIds = (
      db
        .prepare(
          "SELECT x.player_id FROM next_round_roster x JOIN players p ON p.id = x.player_id WHERE x.room_id = ? AND p.status = 'active' ORDER BY p.join_order",
        )
        .all(room.id) as { player_id: string }[]
    ).map((r) => r.player_id);
    if (rosterIds.length < GAME.minPlayers) {
      throw new AppError(
        ERR.TOO_FEW_PLAYERS,
        409,
        `You need at least ${GAME.minPlayers} players before locking. Share the code to invite more.`,
      );
    }
    if (rosterIds.length > GAME.maxPlayers) {
      throw new AppError(ERR.ROOM_FULL, 409, `A round can have at most ${GAME.maxPlayers} players.`);
    }
    const players = rosterIds
      .map((id) => playerById(db, id))
      .filter((p): p is PlayerRow => p !== null);
    const now = Date.now();
    for (const p of players) {
      db.prepare(
        "INSERT OR IGNORE INTO round_roster (round_id, player_id, join_order) VALUES (?, ?, ?)",
      ).run(round.id, p.id, p.join_order);
    }
    db.prepare("UPDATE rounds SET state = 'collecting_words', updated_at = ? WHERE id = ?").run(
      now,
      round.id,
    );
    db.prepare("UPDATE rooms SET locked_at = ?, updated_at = ? WHERE id = ?").run(now, now, room.id);
    touchRoom(db, room.id);
    return getRound(db, round.id) as RoundRow;
  });
}

// Players can edit the confirmed roster of an open round (before locking).
// This is how late friends get added when starting the next round, and how
// someone can be dropped before submissions open.
export function patchNextRoster(
  db: DB,
  sessionId: string,
  room: RoomRow,
  input: { addPlayerId?: string; removePlayerId?: string },
): void {
  requireOrganiser(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round || round.state !== "lobby_open") {
    throw new AppError(ERR.LOCKED, 409, "The roster is locked.");
  }
  withTx(db, () => {
    if (input.addPlayerId) {
      const player = playerById(db, input.addPlayerId);
      if (!player || player.room_id !== room.id || player.status !== "active") {
        throw new AppError(ERR.NOT_FOUND, 404, "That player isn't in this game.");
      }
      const stmt = db.prepare("INSERT OR IGNORE INTO next_round_roster (room_id, player_id) VALUES (?, ?)");
      stmt.run(room.id, input.addPlayerId);
    }
    if (input.removePlayerId) {
      db.prepare("DELETE FROM next_round_roster WHERE room_id = ? AND player_id = ?").run(
        room.id,
        input.removePlayerId,
      );
    }
    touchRoom(db, room.id);
  });
}

export function leaveRoom(db: DB, sessionId: string, room: RoomRow): void {
  const player = requireMember(db, room, sessionId);
  if (player.is_organiser) {
    throw new AppError(ERR.FORBIDDEN, 403, "Organisers can't leave. Cancel the game instead.");
  }
  const round = getRound(db, room.current_round_id);
  const leaveable = !round || ["lobby_open", "collecting_words", "ready_to_read"].includes(round.state);
  if (!leaveable) {
    throw new AppError(ERR.STATE, 409, "This round has started, so you're still part of it.");
  }
  withTx(db, () => {
    db.prepare("UPDATE players SET status = 'left' WHERE id = ?").run(player.id);
    if (round) {
      // Leaving also clears any private submission; readiness derives from the roster.
      db.prepare("DELETE FROM private_submissions WHERE round_id = ? AND player_id = ?").run(
        round.id,
        player.id,
      );
    }
    db.prepare("DELETE FROM next_round_roster WHERE room_id = ? AND player_id = ?").run(room.id, player.id);
    touchRoom(db, room.id);
  });
}

// Only the organiser may remove a player, and only before reading. If removal
// drops the roster below the minimum the round stays collectable and starting
// is blocked until enough players are present. Readiness is recomputed because
// it is derived from the roster, not client counts.
export function removePlayer(db: DB, sessionId: string, room: RoomRow, targetPlayerId: string): void {
  requireOrganiser(db, room, sessionId);
  const target = playerById(db, targetPlayerId);
  if (!target || target.room_id !== room.id || target.status !== "active") {
    throw new AppError(ERR.NOT_FOUND, 404, "That player isn't in this game.");
  }
  if (target.is_organiser) {
    throw new AppError(ERR.VALIDATION, 400, "You can't remove yourself. Cancel the game instead.");
  }
  const round = getRound(db, room.current_round_id);
  if (round && ["reading", "playing", "finished"].includes(round.state)) {
    throw new AppError(ERR.LOCKED, 409, "Players can only be removed before readings begin.");
  }
  withTx(db, () => {
    db.prepare("UPDATE players SET status = 'removed' WHERE id = ?").run(target.id);
    if (round) {
      db.prepare("DELETE FROM private_submissions WHERE round_id = ? AND player_id = ?").run(
        round.id,
        target.id,
      );
    }
    db.prepare("DELETE FROM next_round_roster WHERE room_id = ? AND player_id = ?").run(
      room.id,
      target.id,
    );
    touchRoom(db, room.id);
  });
}

export function cancelRoom(db: DB, sessionId: string, room: RoomRow): void {
  requireOrganiser(db, room, sessionId);
  withTx(db, () => {
    const now = Date.now();
    db.prepare("UPDATE rooms SET state = 'cancelled', updated_at = ? WHERE id = ?").run(now, room.id);
    const round = getRound(db, room.current_round_id);
    if (round && !["finished", "cancelled"].includes(round.state)) {
      db.prepare("UPDATE rounds SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(
        now,
        now,
        round.id,
      );
    }
    // Words, reading lists and the winning-word reveal are deleted on
    // cancellation (retention policy).
    db.prepare("DELETE FROM private_submissions WHERE round_id = ?").run(round?.id ?? "");
    db.prepare("DELETE FROM private_reading_sequences WHERE round_id = ?").run(round?.id ?? "");
    db.prepare("DELETE FROM result_reveals WHERE round_id IN (SELECT id FROM rounds WHERE room_id = ?)").run(room.id);
    touchRoom(db, room.id);
  });
}

// Play another round: preserves the group but creates a fresh round with fresh secrets.
// Roster is confirmed from the previous round's participants; waiting newcomers
// must be explicitly added via patchNextRoster before locking.
export function startNextRound(db: DB, sessionId: string, room: RoomRow): RoundRow {
  requireOrganiser(db, room, sessionId);
  const lastRound = getRound(db, room.current_round_id);
  if (!lastRound || !["finished", "cancelled"].includes(lastRound.state)) {
    throw new AppError(ERR.STATE, 409, "The current round hasn't finished yet.");
  }
  return withTx(db, () => {
    const participantIds = (
      db.prepare("SELECT player_id FROM round_participants WHERE round_id = ?").all(lastRound.id) as {
        player_id: string;
      }[]
    ).map((r) => r.player_id);
    const nextRound = insertRound(
      db,
      room.id,
      (lastRound.seq ?? 0) + 1,
      (getRoomById(db, room.id) as RoomRow).title,
      (getRoomById(db, room.id) as RoomRow).genre,
      "lobby_open",
    );
    db.prepare("DELETE FROM next_round_roster WHERE room_id = ?").run(room.id);
    // The previous round's winning-word reveal is temporary: next round purges it.
    db.prepare("DELETE FROM result_reveals WHERE round_id = ?").run(lastRound.id);
    for (const pid of participantIds) {
      const p = playerById(db, pid);
      if (p && p.status === "active") {
        db.prepare("INSERT OR IGNORE INTO next_round_roster (room_id, player_id) VALUES (?, ?)").run(
          room.id,
          pid,
        );
      }
    }
    db.prepare("UPDATE rooms SET current_round_id = ?, locked_at = NULL, updated_at = ? WHERE id = ?").run(
      nextRound.id,
      Date.now(),
      room.id,
    );
    touchRoom(db, room.id);
    return getRound(db, nextRound.id) as RoundRow;
  });
}

// Public room identity for a join preview: title and status only, no player list.
export function roomPreview(
  db: DB,
  lookup: { code?: string; invitationToken?: string },
): { title: string; genre: string; status: string } {
  let room: RoomRow | null = null;
  if (lookup.invitationToken) {
    room = getRoomByInvitationToken(db, lookup.invitationToken);
  } else if (lookup.code) {
    room = getRoomByCode(db, lookup.code);
  }
  if (!room) throw new AppError(ERR.NOT_FOUND, 404, "No game found with that link. Check it and try again.");
  const round = getRound(db, room.current_round_id);
  let status = "open";
  if (room.state === "cancelled") status = "cancelled";
  else if (round) status = round.state === "lobby_open" ? "open" : "started";
  return { title: room.title, genre: room.genre, status };
}
