import { withTx } from "../db.js";
import type { DB } from "../db.js";
import { AppError, ERR } from "../errors.js";
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
        // Idempotent save: repeated saves never create a second result.
        return existing;
      }
      // Correction: update the same result and keep an audit trail.
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
      touchRoom(db, room.id);
      return getResult(db, round.id) as ResultRow;
    }
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
      Date.now(),
    );
    db.prepare("UPDATE rounds SET state = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(
      Date.now(),
      Date.now(),
      round.id,
    );
    // Completion deletes words and reading payloads (retention policy).
    purgeRoundSecrets(db, round.id);
    touchRoom(db, room.id);
    return getResult(db, round.id) as ResultRow;
  });
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
