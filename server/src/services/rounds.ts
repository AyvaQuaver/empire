import crypto from "node:crypto";
import { withTx } from "../db.js";
import type { DB } from "../db.js";
import { AppError, ERR } from "../errors.js";
import { randomToken, sha256, secureShuffle } from "../ids.js";
import { GAME } from "../config.js";
import { normalizeWord } from "../validation.js";
import {
  getRoomById,
  getRoomByCode,
  getRound,
  playerById,
  requireMember,
  requireOrganiser,
  rosterForRound,
  rosterCount,
  touchRoom,
  type RoomRow,
  type RoundRow,
  type PlayerRow,
} from "./rooms.js";

// Rounds: private submissions, readiness, reading sequences and the speaker
// lease. Functions here are the only code allowed to touch private_* tables,
// and none of them ever returns another player's word or any ownership metadata.

export interface SubmissionRow {
  round_id: string;
  player_id: string;
  word_display: string;
  word_normalized: string;
}

export interface LeaseRow {
  round_id: string;
  holder_player_id: string;
  holder_session_id: string;
  token_hash: string;
  fence: number;
  expires_at: number;
  killed: number;
}

export interface ProgressRow {
  round_id: string;
  reading_number: number;
  position: number;
}

export function getOwnSubmission(db: DB, roundId: string, playerId: string): string | null {
  const row = db
    .prepare("SELECT word_display FROM private_submissions WHERE round_id = ? AND player_id = ?")
    .get(roundId, playerId) as { word_display: string } | undefined;
  return row ? row.word_display : null;
}

export function readyCount(db: DB, roundId: string): { ready: number; total: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.player_id IS NOT NULL THEN 1 ELSE 0 END) AS ready
         FROM round_roster r
         JOIN players p ON p.id = r.player_id AND p.status = 'active'
         LEFT JOIN private_submissions s ON s.round_id = r.round_id AND s.player_id = r.player_id
        WHERE r.round_id = ?`,
    )
    .get(roundId) as { total: number; ready: number | null };
  return { ready: row.ready ?? 0, total: row.total };
}

// Per-player readiness is a status (who has a saved word), never what the word is.
export function rosterReadiness(db: DB, roundId: string): Map<string, boolean> {
  const rows = db
    .prepare(
      `SELECT r.player_id, CASE WHEN s.player_id IS NOT NULL THEN 1 ELSE 0 END AS ready
         FROM round_roster r JOIN players p ON p.id = r.player_id AND p.status = 'active'
         LEFT JOIN private_submissions s ON s.round_id = r.round_id AND s.player_id = r.player_id
        WHERE r.round_id = ?`,
    )
    .all(roundId) as { player_id: string; ready: number }[];
  return new Map(rows.map((r) => [r.player_id, r.ready === 1]));
}

function recomputeRoundState(db: DB, round: RoundRow): RoundRow {
  const { ready, total } = readyCount(db, round.id);
  const target = total > 0 && ready === total && total >= GAME.minPlayers ? "ready_to_read" : "collecting_words";
  if (target !== round.state) {
    db.prepare("UPDATE rounds SET state = ?, updated_at = ? WHERE id = ?").run(target, Date.now(), round.id);
    round.state = target;
  }
  return round;
}

export function submitWord(
  db: DB,
  roomCode: string,
  sessionId: string,
  rawWord: string,
): { round: RoundRow; word: string } {
  const room = getRoomByCode(db, roomCode);
  if (!room) throw new AppError(ERR.NOT_FOUND, 404, "Room not found.");
  const player = requireMember(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round) throw new AppError(ERR.STATE, 409, "No active round.");
  if (!["collecting_words", "ready_to_read"].includes(round.state)) {
    throw new AppError(ERR.LOCKED, 409, "Words are locked for this round.");
  }
  const inRoster = db
    .prepare("SELECT 1 FROM round_roster WHERE round_id = ? AND player_id = ?")
    .get(round.id, player.id);
  if (!inRoster) {
    throw new AppError(ERR.STATE, 409, "You joined after this round started. You'll join the next one.");
  }
  const v = normalizeWord(rawWord);
  if (!v.ok) throw new AppError(v.code, 400, v.message, { field: v.field });

  return withTx(db, () => {
    // Duplicate check happens BEFORE any write so a rejected change never
    // loses the player's previous valid submission.
    const dupe = db
      .prepare(
        "SELECT 1 FROM private_submissions WHERE round_id = ? AND word_normalized = ? AND player_id != ?",
      )
      .get(round.id, v.normalized, player.id);
    if (dupe) {
      // Never reveals which player holds the word.
      throw new AppError(ERR.WORD_TAKEN, 409, "That word is already taken. Try another.");
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO private_submissions (round_id, player_id, word_display, word_normalized, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(round_id, player_id) DO UPDATE SET
         word_display = excluded.word_display,
         word_normalized = excluded.word_normalized,
         updated_at = excluded.updated_at`,
    ).run(round.id, player.id, v.display, v.normalized, now, now);
    const updated = recomputeRoundState(db, { ...round });
    touchRoom(db, room.id);
    return { round: updated, word: v.display };
  });
}

// ---- Reading start ----


/* Round-authoritative word pacing (see migration 0005): one utterance completes,
 * a gap follows, then the next word starts. Only these values are accepted;
 * anything else is a validation error. NULL on the row means the speaker default
 * (1000). The authorised speaker may change it before playback or while paused;
 * a replacement speaker inherits the active round's value. */
export const ALLOWED_WORD_PAUSE_MS = [1000, 1500, 2000, 3000] as const;
export const DEFAULT_WORD_PAUSE_MS = 1000;

export function effectiveWordPauseMs(round: RoundRow | null): number {
  const value = round?.word_pause_ms ?? null;
  return (ALLOWED_WORD_PAUSE_MS as readonly number[]).includes(value ?? -1) ? (value as number) : DEFAULT_WORD_PAUSE_MS;
}

/** Validate + set the round's pacing. Authorisation: the organiser OR the
 * current speaker-lease holder. Caller supplies the round; the DB row wins. */
export function setWordPause(
  db: DB,
  room: RoomRow,
  round: RoundRow,
  sessionId: string,
  requestedMs: number | null,
): number {
  if (round.state !== "ready_to_read" && round.state !== "reading") {
    throw new AppError(ERR.STATE, 409, "Pacing can only change while preparing or running readings.");
  }
  const authorised =
    (() => {
      try {
        requireOrganiser(db, room, sessionId);
        return true;
      } catch {
        const lease = getLease(db, round.id);
        return !!(lease && lease.killed !== 1 && lease.expires_at > Date.now() && lease.holder_session_id === sessionId);
      }
    })();
  if (!authorised) {
    throw new AppError(ERR.FORBIDDEN, 403, "Only the organiser or the current speaker can change pacing.");
  }
  if (requestedMs === null) {
    throw new AppError(ERR.VALIDATION, 400, "Choose a pause between words.");
  }
  const ms = Number(requestedMs);
  if (!(ALLOWED_WORD_PAUSE_MS as readonly number[]).includes(ms)) {
    throw new AppError(ERR.VALIDATION, 400, "Unsupported pause between words.");
  }
  db.prepare("UPDATE rounds SET word_pause_ms = ?, updated_at = ? WHERE id = ?").run(ms, Date.now(), round.id);
  return ms;
}

export interface StartReadingResult {
  round: RoundRow;
  words: string[];
  readingNumber: number;
  leaseToken: string;
}

export function startReading(db: DB, roomCode: string, sessionId: string): StartReadingResult {
  const room = getRoomByCode(db, roomCode);
  if (!room) throw new AppError(ERR.NOT_FOUND, 404, "Room not found.");
  const organiser = requireOrganiser(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round) throw new AppError(ERR.STATE, 409, "No active round.");
  if (round.state === "reading" || round.state === "playing") {
    // Idempotent-ish: repeated start requests do NOT regenerate shuffles or starters.
    throw new AppError(ERR.STATE, 409, "Readings already started. Resume or take over from the reading screen.");
  }
  if (round.state !== "ready_to_read") {
    if (round.state === "playing") throw new AppError(ERR.STATE, 409, "This round is already in play.");
    throw new AppError(ERR.STATE, 409, "Wait until everyone has submitted a word.");
  }

  return withTx(db, () => {
    const count = rosterCount(db, round.id);
    if (count < GAME.minPlayers) {
      throw new AppError(ERR.TOO_FEW_PLAYERS, 409, `You need at least ${GAME.minPlayers} players to start.`);
    }
    const { ready, total } = readyCount(db, round.id);
    if (total - ready > 0) {
      throw new AppError(ERR.STATE, 409, "Wait until everyone has submitted a word.");
    }

    // Snapshot participants for the permanent (non-secret) history.
    const roster = rosterForRound(db, round.id);
    for (const p of roster) {
      db.prepare(
        "INSERT OR IGNORE INTO round_participants (round_id, player_id, display_name, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(round.id, p.id, p.display_name, p.user_id, Date.now());
    }

    // Three independent uniformly shuffled word-only lists, generated server-side.
    const words = (
      db.prepare("SELECT word_display FROM private_submissions WHERE round_id = ?").all(round.id) as {
        word_display: string;
      }[]
    ).map((r) => r.word_display);
    for (let n = 1; n <= GAME.readingCount; n++) {
      const shuffled = secureShuffle(words);
      db.prepare(
        "INSERT OR REPLACE INTO private_reading_sequences (round_id, reading_number, words_json) VALUES (?, ?, ?)",
      ).run(round.id, n, JSON.stringify(shuffled));
    }

    // Uniformly random starter, announced after the third reading finishes, from a
    // secure randomness source.
    const starterPlayer = roster[crypto.randomInt(roster.length)];

    const now = Date.now();
    db.prepare("UPDATE rounds SET state = 'reading', started_at = ?, starter_player_id = ?, updated_at = ? WHERE id = ?").run(
      now,
      starterPlayer.id,
      now,
      round.id,
    );
    db.prepare(
      "INSERT OR REPLACE INTO reading_progress (round_id, reading_number, position, acked_at) VALUES (?, 1, 0, ?)",
    ).run(round.id, now);

    // The organiser (caller) is granted the first speaker lease.
    const token = issueLease(db, round.id, organiser, sessionId, now);
    touchRoom(db, room.id);
    const resultRound = getRound(db, round.id) as RoundRow;
    const seq = sequenceWords(db, round.id, 1);
    return { round: resultRound, words: seq, readingNumber: 1, leaseToken: token };
  });
}

// (keeps the crypto import local)

export function sequenceWords(db: DB, roundId: string, readingNumber: number): string[] {
  const row = db
    .prepare("SELECT words_json FROM private_reading_sequences WHERE round_id = ? AND reading_number = ?")
    .get(roundId, readingNumber) as { words_json: string } | undefined;
  return row ? (JSON.parse(row.words_json) as string[]) : [];
}

export function getLease(db: DB, roundId: string): LeaseRow | null {
  const row = db.prepare("SELECT * FROM speaker_leases WHERE round_id = ?").get(roundId) as
    | LeaseRow
    | undefined;
  return row ?? null;
}

export function progressFor(db: DB, roundId: string): ProgressRow {
  let row = db.prepare("SELECT * FROM reading_progress WHERE round_id = ?").get(roundId) as
    | ProgressRow
    | undefined;
  if (!row) {
    db.prepare("INSERT OR REPLACE INTO reading_progress (round_id, reading_number, position, acked_at) VALUES (?, 1, 0, ?)").run(
      roundId,
      Date.now(),
    );
    row = { round_id: roundId, reading_number: 1, position: 0 };
  }
  return row;
}

function issueLease(db: DB, roundId: string, player: PlayerRow, sessionId: string, now: number): string {
  const token = randomToken(24);
  const fenceRow = db
    .prepare("SELECT COALESCE(MAX(fence), 0) AS f FROM speaker_leases WHERE round_id = ?")
    .get(roundId) as { f: number };
  const old = getLease(db, roundId);
  if (old) db.prepare("UPDATE speaker_leases SET killed = 1 WHERE round_id = ?").run(roundId);
  db.prepare(
    `INSERT OR REPLACE INTO speaker_leases
       (round_id, holder_player_id, holder_session_id, token_hash, fence, acquired_at, expires_at, killed)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(roundId, player.id, sessionId, sha256(token), (old?.fence ?? fenceRow.f) + 1, now, now + GAME.leaseTtlMs);
  return token;
}

export interface LeaseInfo {
  mine: boolean;
  fence: number;
}

function checkLease(db: DB, roundId: string, sessionId: string, leaseToken: string | null): LeaseRow {
  const lease = getLease(db, roundId);
  if (!lease || lease.killed === 1 || lease.expires_at <= Date.now()) {
    throw new AppError(ERR.UNAUTHENTICATED, 403, "You're not the current speaker. Take over to continue.");
  }
  if (lease.holder_session_id !== sessionId) {
    throw new AppError(ERR.FORBIDDEN, 403, "Someone else is speaking on this device.");
  }
  if (!leaseToken || sha256(leaseToken) !== lease.token_hash) {
    throw new AppError(ERR.FORBIDDEN, 403, "This tab isn't the active speaker. Close other copies or resume.");
  }
  return lease;
}

export function acquireLease(
  db: DB,
  round: RoundRow,
  sessionId: string,
  player: PlayerRow,
  _opts: { leaseToken?: string | null } = {},
): { leaseToken: string; mine: true } {
  const existing = getLease(db, round.id);
  const active = existing && existing.killed === 0 && existing.expires_at > Date.now();
  return withTx(db, () => {
    if (active) {
      if (existing.holder_session_id === sessionId) {
        // Same session re-acquiring (e.g. after a refresh): refresh the lease fencing.
      } else {
        // No silent override of an active speaker: the transfer must go through
        // the organiser's authorization + the other device's explicit acceptance.
        // Recovery claims happen only when the lease has expired or is absent.
        throw new AppError(ERR.SPEAKER_ACTIVE, 409, "Someone is already speaking on this screen.");
      }
    }
    const token = issueLease(db, round.id, player, sessionId, Date.now());
    return { leaseToken: token, mine: true };
  });
}

// ---- Organiser-approved speaker transfer ------------------------------------
// Roles: the organiser manages the room and approves speaker changes; the
// speaker plays the anonymous reading sequence; every other player just plays.
// A transfer is a short-lived, single-use, round+participant-bound
// authorization. The selected participant accepts ON THEIR OWN DEVICE — the
// acceptance atomically issues the new lease and fences out the old one.

const TRANSFER_TTL_MS = 5 * 60 * 1000;

export function authorizeSpeakerTransfer(
  db: DB,
  room: RoomRow,
  sessionId: string,
  targetPlayerId: string,
): { expiresAt: number } {
  const organiser = requireOrganiser(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round || round.state !== "reading") {
    throw new AppError(ERR.STATE, 409, "Speaker changes are only possible during readings.");
  }
  const target = playerById(db, targetPlayerId);
  const inRoster = target
    ? db.prepare("SELECT 1 FROM round_roster WHERE round_id = ? AND player_id = ?").get(round.id, target.id)
    : undefined;
  if (!target || !inRoster || target.status !== "active") {
    throw new AppError(ERR.VALIDATION, 400, "Pick a current round participant as the next speaker.");
  }
  void organiser;
  const now = Date.now();
  return withTx(db, () => {
    // Only one pending hand-off at a time: earlier authorizations are cancelled.
    db.prepare(
      "UPDATE speaker_transfers SET cancelled_at = ? WHERE round_id = ? AND used_at IS NULL AND cancelled_at IS NULL",
    ).run(now, round.id);
    db.prepare(
      `INSERT INTO speaker_transfers (round_id, to_player_id, created_by_player_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(round_id, to_player_id) DO UPDATE SET
         created_by_player_id = excluded.created_by_player_id,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         used_at = NULL,
         cancelled_at = NULL`,
    ).run(round.id, target.id, organiser.id, now, now + TRANSFER_TTL_MS);
    return { expiresAt: now + TRANSFER_TTL_MS };
  });
}

export function cancelPendingSpeakerTransfer(db: DB, roundId: string, toPlayerId: string): void {
  db.prepare(
    "UPDATE speaker_transfers SET cancelled_at = ? WHERE round_id = ? AND to_player_id = ? AND used_at IS NULL AND cancelled_at IS NULL",
  ).run(Date.now(), roundId, toPlayerId);
}

export function pendingSpeakerTransferFor(db: DB, roundId: string, playerId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM speaker_transfers WHERE round_id = ? AND to_player_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?",
    )
    .get(roundId, playerId, Date.now());
  return row !== undefined;
}

/** Explicit acceptance by the authorized participant, on their own device. */
export function acceptSpeakerTransfer(db: DB, round: RoundRow, sessionId: string, player: PlayerRow): string {
  if (round.state !== "reading") {
    throw new AppError(ERR.EXPIRED, 410, "This round is no longer active, so the speaker can't change.");
  }
  return withTx(db, () => {
    const row = db
      .prepare(
        "SELECT * FROM speaker_transfers WHERE round_id = ? AND to_player_id = ? AND used_at IS NULL AND cancelled_at IS NULL",
      )
      .get(round.id, player.id) as { id: number; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now()) {
      throw new AppError(ERR.EXPIRED, 410, "That speaker hand-off isn't available. Ask the organiser to authorize it again.");
    }
    // Atomic: acceptance consumes the authorization AND issues the new lease
    // (which kills the old lease, bumping the fence). A second concurrent
    // acceptance or a second issuance can't create two valid leases — the row
    // is now used, and INSERT OR REPLACE in issueLease keeps a single lease row.
    db.prepare("UPDATE speaker_transfers SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
    const token = issueLease(db, round.id, player, sessionId, Date.now());
    return token;
  });
}

export function renewLease(db: DB, round: RoundRow, sessionId: string, leaseToken: string): void {
  withTx(db, () => {
    const lease = checkLease(db, round.id, sessionId, leaseToken);
    db.prepare("UPDATE speaker_leases SET expires_at = ? WHERE round_id = ?").run(
      Date.now() + GAME.leaseTtlMs,
      lease.round_id,
    );
  });
}

export function releaseLease(db: DB, round: RoundRow, sessionId: string, leaseToken: string): void {
  withTx(db, () => {
    const lease = checkLease(db, round.id, sessionId, leaseToken);
    db.prepare("UPDATE speaker_leases SET killed = 1 WHERE round_id = ?").run(lease.round_id);
  });
}

// ---- Reading payload & progress ----

// Only the lease-holding speaker device receives the shuffled word-only array.
export function getReadingPayload(
  db: DB,
  room: RoomRow,
  round: RoundRow,
  sessionId: string,
  leaseToken: string,
  readingNumber: number,
): { readingNumber: number; words: string[] } {
  const lease = checkLease(db, round.id, sessionId, leaseToken);
  void lease;
  const progress = progressFor(db, round.id);
  if (readingNumber !== progress.reading_number) {
    throw new AppError(ERR.STATE, 409, "That reading is not the current one.");
  }
  if (round.state !== "reading") {
    throw new AppError(ERR.STATE, 409, "Readings aren't in progress.");
  }
  return { readingNumber, words: sequenceWords(db, round.id, readingNumber) };
}

export function ackPosition(
  db: DB,
  round: RoundRow,
  sessionId: string,
  leaseToken: string,
  readingNumber: number,
  position: number,
): void {
  withTx(db, () => {
    const lease = checkLease(db, round.id, sessionId, leaseToken);
    if (lease.fence !== leaseIdFence(db, round.id)) throw new AppError(ERR.FORBIDDEN, 403, "Stale speaker session.");
    if (round.state !== "reading") {
      // Round already finished — acks after completion are rejected via fencing.
      throw new AppError(ERR.FORBIDDEN, 403, "Readings already finished for this round.");
    }
    const progress = progressFor(db, round.id);
    if (readingNumber !== progress.reading_number) {
      throw new AppError(ERR.STATE, 409, "That reading is not the current one.");
    }
    if (!Number.isInteger(position) || position < 0 || position > 40) {
      throw new AppError(ERR.VALIDATION, 400, "Invalid position.");
    }
    // Monotonic: stale/takeover replay cannot rewind public progress.
    const next = Math.max(progress.position, position);
    db.prepare("UPDATE reading_progress SET position = ?, acked_at = ? WHERE round_id = ?").run(
      next,
      Date.now(),
      round.id,
    );
  });
}

function leaseIdFence(db: DB, roundId: string): number {
  const row = db.prepare("SELECT fence, killed, expires_at FROM speaker_leases WHERE round_id = ?").get(roundId) as
    | { fence: number; killed: number; expires_at: number }
    | undefined;
  if (!row || row.killed === 1 || row.expires_at <= Date.now()) return -1;
  return row.fence;
}

export function completeReading(
  db: DB,
  round: RoundRow,
  sessionId: string,
  leaseToken: string,
  readingNumber: number,
): { readingNumber: number; finishedPlay: boolean } {
  return withTx(db, () => {
    checkLease(db, round.id, sessionId, leaseToken);
    const progress = progressFor(db, round.id);
    if (round.state !== "reading") throw new AppError(ERR.STATE, 409, "Readings aren't in progress.");
    if (readingNumber !== progress.reading_number) {
      const isOld = readingNumber < progress.reading_number;
      throw new AppError(ERR.STATE, 409, isOld ? "That reading was already finished." : "Finish the current reading first.");
    }
    if (readingNumber < GAME.readingCount) {
      db.prepare("UPDATE reading_progress SET reading_number = ?, position = 0, acked_at = ? WHERE round_id = ?").run(
        readingNumber + 1,
        Date.now(),
        round.id,
      );
      return { readingNumber: readingNumber + 1, finishedPlay: false };
    }
    // Third reading completes; announce the saved starter and relieve the lease.
    const now = Date.now();
    db.prepare("UPDATE rounds SET state = 'playing', updated_at = ? WHERE id = ?").run(now, round.id);
    return { readingNumber, finishedPlay: true };
  });
}

// Restart the current reading: repeats the SAME saved shuffle, never regenerates.
export function restartReading(
  db: DB,
  room: RoomRow,
  round: RoundRow,
  sessionId: string,
  player: PlayerRow,
  readingNumber: number,
  leaseToken: string | null,
): StartReadingResult {
  return withTx(db, () => {
    if (round.state !== "reading") throw new AppError(ERR.STATE, 409, "Readings aren't in progress.");
    const progress = progressFor(db, round.id);
    if (readingNumber !== progress.reading_number) {
      // Allow restarting only the current reading.
      throw new AppError(ERR.STATE, 409, "Only the current reading can be restarted.");
    }
    let token: string;
    if (leaseToken) {
      checkLease(db, round.id, sessionId, leaseToken); // still valid: keep it
      token = leaseToken;
    } else if (player.is_organiser) {
      // Organiser's lease lapsed; explicitly re-issue on restart (never auto-silent).
      token = issueLease(db, round.id, player, sessionId, Date.now());
    } else {
      throw new AppError(ERR.FORBIDDEN, 403, "Only the organiser can restart a reading.");
    }
    db.prepare("UPDATE reading_progress SET position = 0, acked_at = ? WHERE round_id = ?").run(
      Date.now(),
      round.id,
    );
    touchRoom(db, room.id);
    return { round: getRound(db, round.id) as RoundRow, words: sequenceWords(db, round.id, readingNumber), readingNumber, leaseToken: token as string };
  });
}

export function getStarterPlayer(db: DB, round: RoundRow): PlayerRow | null {
  if (!round.starter_player_id) return null;
  return playerById(db, round.starter_player_id);
}

export function cancelRound(db: DB, sessionId: string, room: RoomRow): void {
  requireOrganiser(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round || ["finished", "cancelled"].includes(round.state)) {
    throw new AppError(ERR.STATE, 409, "This round has already ended.");
  }
  withTx(db, () => {
    const now = Date.now();
    db.prepare("UPDATE rounds SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, round.id);
    db.prepare("DELETE FROM private_submissions WHERE round_id = ?").run(round.id);
    db.prepare("DELETE FROM private_reading_sequences WHERE round_id = ?").run(round.id);
    db.prepare("DELETE FROM speaker_leases WHERE round_id = ?").run(round.id);
    touchRoom(db, room.id);
  });
}

export { getRoomById };
