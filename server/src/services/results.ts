import { withTx } from "../db.js";
import type { DB } from "../db.js";
import { AppError, ERR } from "../errors.js";
import { normalizeWord } from "../validation.js";
import {
  getRound,
  playerById,
  requireMember,
  requireOrganiser,
  touchRoom,
  type RoomRow,
} from "./rooms.js";

// Results are organiser-reported. Wins are derived from the single result row
// per round, so corrections reconcile statistics without inventing game counts.

export interface ResultRow {
  round_id: string;
  room_id: string;
  round_seq: number;
  genre: string;
  winner_player_id: string;
  winner_name: string;
  winner_user_id: string | null;
  recorded_by_player_id: string;
  recorded_by_name: string;
  recorded_by_user_id: string | null;
  recorded_at: number;
  corrected_at: number | null;
  correction_count: number;
}

export function getResult(db: DB, roundId: string): ResultRow | null {
  const row = db.prepare("SELECT * FROM game_results WHERE round_id = ?").get(roundId) as
    | ResultRow
    | undefined;
  return row ?? null;
}

export function purgeRoundSecrets(db: DB, roundId: string): void {
  db.prepare("DELETE FROM private_submissions WHERE round_id = ?").run(roundId);
  db.prepare("DELETE FROM private_reading_sequences WHERE round_id = ?").run(roundId);
}

// Reveal TTL: temporary winning-word visibility (24h from result creation).
export const REVEAL_TTL_MS = 24 * 3600 * 1000;

export function recordResult(
  db: DB,
  sessionId: string,
  room: RoomRow,
  winnerPlayerId: string,
): ResultRow {
  const organiser = requireOrganiser(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round || !["playing", "finished"].includes(round.state)) {
    throw new AppError(ERR.STATE, 409, "A winner can be recorded after the readings finish.");
  }
  const winner = playerById(db, winnerPlayerId);
  if (!winner || winner.room_id !== room.id) {
    throw new AppError(ERR.VALIDATION, 400, "Pick one of this round's players.");
  }
  const participant = db
    .prepare("SELECT 1 FROM round_participants WHERE round_id = ? AND player_id = ?")
    .get(round.id, winner.id);
  if (!participant) {
    throw new AppError(ERR.VALIDATION, 400, "Pick one of this round's players.");
  }
  const recordedBy = playerById(db, organiser.id) as typeof winner;

  return withTx(db, () => {
    const existing = getResult(db, round.id) as ResultRow | null;
    if (existing) {
      if (existing.winner_player_id === winner.id) {
        // Idempotent save: repeated saves never create a second result. The
        // existing reveal stays as-is (its TTL simply is not extended).
        return existing;
      }
      // Correction: update the same result, keep the audit trail, and REMOVE
      // the previous winner's reveal word (the corrected winner may supply a
      // replacement themselves via submitRevealWord).
      db.prepare(
        `INSERT INTO result_audit
           (round_id, previous_winner_name, previous_winner_user_id, new_winner_name, new_winner_user_id, changed_by_name, changed_by_user_id, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        round.id,
        existing.winner_name,
        existing.winner_user_id,
        winner.display_name,
        winner.user_id,
        recordedBy.display_name,
        recordedBy.user_id,
        Date.now(),
      );
      db.prepare(
        `UPDATE game_results SET winner_player_id = ?, winner_name = ?, winner_user_id = ?,
           recorded_by_player_id = ?, recorded_by_name = ?, recorded_by_user_id = ?,
           recorded_at = ?, corrected_at = ?, correction_count = correction_count + 1
         WHERE round_id = ?`,
      ).run(
        winner.id,
        winner.display_name,
        winner.user_id,
        organiser.id,
        recordedBy.display_name,
        recordedBy.user_id,
        Date.now(),
        Date.now(),
        round.id,
      );
      // Version bump ties reveal changes to the current result version: a
      // delayed replacement attempt from a previously selected winner is
      // rejected by checking the CURRENT winner below.
      const fresh = db
        .prepare("SELECT result_version FROM result_reveals WHERE round_id = ?")
        .get(round.id) as { result_version: number } | undefined;
      if (fresh) {
        db.prepare(
          "UPDATE result_reveals SET word = NULL, result_version = result_version + 1, updated_at = ?, winner_player_id = ? WHERE round_id = ?",
        ).run(Date.now(), winner.id, round.id);
      } else {
        // No original reveal existed (e.g. word already purged earlier); create
        // an empty one so the corrected winner can still enter a replacement.
        db.prepare(
          "INSERT OR IGNORE INTO result_reveals (round_id, result_version, winner_player_id, word, source, created_at, updated_at, expires_at) VALUES (?, 2, ?, NULL, 'replacement', ?, ?, ?)",
        ).run(round.id, winner.id, Date.now(), Date.now(), Date.now() + REVEAL_TTL_MS);
      }
      touchRoom(db, room.id);
      return getResult(db, round.id) as ResultRow;
    }
    // Initial save: capture the WINNING word, then destroy everyone's private
    // submissions (deliberate, documented privacy change: only the winner word
    // survives on the temporary reveal record).
    const winningWord = db
      .prepare("SELECT word_display FROM private_submissions WHERE round_id = ? AND player_id = ?")
      .get(round.id, winner.id) as { word_display: string } | undefined;
    const now = Date.now();
    db.prepare(
      `INSERT INTO game_results
         (round_id, room_id, round_seq, genre, winner_player_id, winner_name, winner_user_id,
          recorded_by_player_id, recorded_by_name, recorded_by_user_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      round.id,
      room.id,
      round.seq,
      round.genre,
      winner.id,
      winner.display_name,
      winner.user_id,
      organiser.id,
      recordedBy.display_name,
      recordedBy.user_id,
      now,
    );
    db.prepare("UPDATE rounds SET state = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      round.id,
    );
    db.prepare(
      `INSERT INTO result_reveals (round_id, result_version, winner_player_id, word, source, created_at, updated_at, expires_at)
       VALUES (?, 1, ?, ?, 'original', ?, ?, ?)`,
    ).run(round.id, winner.id, winningWord ? winningWord.word_display : null, now, now, now + REVEAL_TTL_MS);
    // Completion deletes ALL words and reading payloads (retention policy);
    // only the winner's word lives on in result_reveals (time-limited).
    purgeRoundSecrets(db, round.id);
    touchRoom(db, room.id);
    return getResult(db, round.id) as ResultRow;
  });
}

export interface RevealView {
  word: string | null;
  expiresAt: number;
  expired: boolean;
  canSubmitReplacement: boolean;
}

/** Round participants only (never friends/outsiders); read-time expiry enforced. */
export function resultRevealFor(db: DB, room: RoomRow, sessionId: string): RevealView | null {
  requireMember(db, room, sessionId); // membership gate; rows below use the session id
  const round = getRound(db, room.current_round_id);
  if (!round) return null;
  const reveal = db
    .prepare("SELECT * FROM result_reveals WHERE round_id = ?")
    .get(round.id) as
    | { word: string | null; result_version: number; winner_player_id: string; source: string; expires_at: number; created_at: number }
    | undefined;
  if (!reveal) return null;
  // Access is limited to sessions bound to THAT round's participants.
  const isInRound = db
    .prepare(
      `SELECT 1 FROM round_participants rp
         JOIN players p ON p.id = rp.player_id
        WHERE rp.round_id = ?
          AND (p.session_id = ? OR (p.user_id IS NOT NULL AND p.user_id = (SELECT user_id FROM sessions WHERE id = ?)))`,
    )
    .get(round.id, sessionId, sessionId);
  if (!isInRound) {
    throw new AppError(ERR.FORBIDDEN, 403, "Only this round's players can see the reveal.");
  }
  const isCurrentWinner = db
    .prepare(
      `SELECT 1 FROM game_results gr JOIN players p ON p.id = gr.winner_player_id
        WHERE gr.round_id = ? AND (p.session_id = ? OR (p.user_id IS NOT NULL AND p.user_id = (SELECT user_id FROM sessions WHERE id = ?)))`,
    )
    .get(round.id, sessionId, sessionId) !== undefined;
  const now = Date.now();
  const expired = reveal.expires_at <= now;
  return {
    word: expired ? null : reveal.word,
    expiresAt: reveal.expires_at,
    expired,
    canSubmitReplacement: reveal.word === null && !expired && isCurrentWinner && reveal.result_version > 1,
  };
}

/** The CURRENT corrected winner may enter their own replacement reveal word. */
export function submitRevealWord(db: DB, room: RoomRow, sessionId: string, rawWord: string): void {
  requireMember(db, room, sessionId); // membership gate; identity uses the session id
  const round = getRound(db, room.current_round_id);
  if (!round) throw new AppError(ERR.STATE, 409, "Round not found.");
  const result = getResult(db, round.id);
  if (!result) throw new AppError(ERR.STATE, 409, "No result to attribute the word to.");
  const reveal = db.prepare("SELECT * FROM result_reveals WHERE round_id = ?").get(round.id) as
    | { word: string | null; result_version: number; expires_at: number; winner_player_id: string }
    | undefined;
  if (!reveal) throw new AppError(ERR.NOT_FOUND, 404, "No reveal record for this round.");
  if (reveal.winner_player_id !== result.winner_player_id) {
    throw new AppError(ERR.STATE, 409, "Only the current winner can provide the word.");
  }
  const winnerRow = playerById(db, result.winner_player_id);
  if (!winnerRow) throw new AppError(ERR.NOT_FOUND, 404, "That player isn't in this game.");
  const isWinner =
    winnerRow.session_id === sessionId ||
    (winnerRow.user_id !== null &&
      winnerRow.user_id === (db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId) as { user_id: string | null } | undefined)?.user_id);
  if (!isWinner) {
    throw new AppError(ERR.FORBIDDEN, 403, "Only the current winner can provide the word.");
  }
  // (Re-entry by the same winner is allowed: typing their word again replaces it.)
  if (reveal.expires_at <= Date.now()) {
    throw new AppError(ERR.EXPIRED, 410, "The reveal window for this result has ended.");
  }
  const v = normalizeWord(rawWord);
  if (!v.ok) throw new AppError(v.code, 400, v.message, { field: v.field });
  // Tied to the result_version implicitly: the winner id check plus the
  // correction flow's version bump mean a stale submitter was already demoted.
  db.prepare("UPDATE result_reveals SET word = ?, source = 'replacement', updated_at = ? WHERE round_id = ?").run(
    v.display,
    Date.now(),
    round.id,
  );
}

export function isParticipant(db: DB, roundId: string, playerId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM round_participants WHERE round_id = ? AND player_id = ?")
    .get(roundId, playerId);
}

export interface ResultView {
  roundSeq: number;
  genre: string;
  winnerName: string;
  winnerPlayerId: string;
  recordedByName: string;
  recordedAt: number;
  correctionCount: number;
  participants: { playerId: string; name: string }[];
  isOrganiser: boolean;
}

// Reading a result requires room membership.
export function resultView(db: DB, room: RoomRow, sessionId: string): ResultView {
  const me = requireMember(db, room, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!round) throw new AppError(ERR.NOT_FOUND, 404, "Round not found.");
  const result = getResult(db, round.id);
  const participants = (
    db
      .prepare("SELECT player_id, display_name FROM round_participants WHERE round_id = ? ORDER BY rowid")
      .all(round.id) as { player_id: string; display_name: string }[]
  ).map((p) => ({ playerId: p.player_id, name: p.display_name }));
  return {
    roundSeq: round.seq,
    genre: round.genre,
    winnerName: result?.winner_name ?? "",
    winnerPlayerId: result?.winner_player_id ?? "",
    recordedByName: result?.recorded_by_name ?? "",
    recordedAt: result?.recorded_at ?? 0,
    correctionCount: result?.correction_count ?? 0,
    participants,
    isOrganiser: me.is_organiser === 1,
  };
}
