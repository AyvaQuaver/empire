import type { DB } from "../db.js";

// History and statistics: completed, organiser-reported rounds only.
// History is derived from game results and participant snapshots and never
// includes any words.
//
// Identity resolution:
//  - Account: a participant row whose user_id (snapshot) OR the players.user_id
//    binding matches the signed-in user (this keeps history through guest→account
//    upgrade). The same resolution applies to the winner.
//  - Guest: only by the server-derived player ids of that exact browser session.

export interface GameRow {
  roundId: string;
  roomId: string;
  roundSeq: number;
  roomTitle: string;
  genre: string;
  finishedAt: number;
  winnerName: string;
  won: boolean;
}

export function gamesForUser(
  db: DB,
  userId: string | null,
  sessionPlayerIds: string[],
): GameRow[] {
  const playerIds = sessionPlayerIds.filter(Boolean);
  if (!userId && playerIds.length === 0) return [];
  const places = playerIds.map(() => "?").join(",");
  const playerFilter = playerIds.length > 0 ? ` OR pp.id IN (${places})` : "";

  const rows = db
    .prepare(
      `SELECT r.id AS round_id, r.room_id, r.seq AS round_seq, r.title AS room_title, r.genre,
              r.finished_at, gr.winner_name, gr.winner_user_id, gr.winner_player_id,
              wpl.user_id AS winner_bound_user_id
         FROM game_results gr
         JOIN rounds r ON r.id = gr.round_id AND r.state = 'finished'
         JOIN players wpl ON wpl.id = gr.winner_player_id
        WHERE EXISTS (
          SELECT 1 FROM round_participants rp
            JOIN players pp ON pp.id = rp.player_id
           WHERE rp.round_id = gr.round_id
             AND (COALESCE(rp.user_id, pp.user_id) = ?${playerFilter})
        )
        ORDER BY r.finished_at DESC, r.seq DESC`,
    )
    .all(userId ?? "", ...(playerIds.length ? playerIds : [])) as {
    round_id: string;
    room_id: string;
    round_seq: number;
    room_title: string;
    genre: string;
    finished_at: number | null;
    winner_name: string;
    winner_user_id: string | null;
    winner_player_id: string;
    winner_bound_user_id: string | null;
  }[];

  return rows.map((row) => {
    const effectiveWinnerUser = row.winner_user_id ?? row.winner_bound_user_id;
    const won = userId
      ? effectiveWinnerUser === userId
      : row.winner_user_id === null && playerIds.includes(row.winner_player_id);
    return {
      roundId: row.round_id,
      roomId: row.room_id,
      roundSeq: row.round_seq,
      roomTitle: row.room_title,
      genre: row.genre,
      finishedAt: row.finished_at ?? 0,
      winnerName: row.winner_name,
      won,
    };
  });
}

export function statsForUser(
  db: DB,
  userId: string | null,
  sessionPlayerIds: string[],
): { gamesPlayed: number; wins: number } {
  const games = gamesForUser(db, userId, sessionPlayerIds);
  return { gamesPlayed: games.length, wins: games.filter((g) => g.won).length };
}
