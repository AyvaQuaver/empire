import type { DB } from "../db.js";
import { config } from "../config.js";

// Retention: words and reading payloads are deleted on finish/cancel, and a
// scheduled job purges abandoned/inactive rounds within the inactivity window.
// Nothing here ever writes words to telemetry or logs.

export function purgeRoundSecrets(db: DB, roundId: string): void {
  db.prepare("DELETE FROM private_submissions WHERE round_id = ?").run(roundId);
  db.prepare("DELETE FROM private_reading_sequences WHERE round_id = ?").run(roundId);
}

export function purgeRoomSecrets(db: DB, roomId: string): void {
  db.prepare(
    "DELETE FROM private_submissions WHERE round_id IN (SELECT id FROM rounds WHERE room_id = ?)",
  ).run(roomId);
  db.prepare(
    "DELETE FROM private_reading_sequences WHERE round_id IN (SELECT id FROM rounds WHERE room_id = ?)",
  ).run(roomId);
}

// Expire rooms whose last real activity is older than the configured window.
// Rooms refresh activity on meaningful interactions, so active family sessions
// are not expired mid-game by an unrelated creation-time limit.
export function expireInactiveRooms(db: DB, now = Date.now()): number {
  const cutoff = now - config.purgeInactivityHours * 3600 * 1000;
  const stale = db
    .prepare("SELECT id FROM rooms WHERE state = 'open' AND last_activity_at < ?")
    .all(cutoff) as { id: string }[];
  let count = 0;
  for (const room of stale) {
    const round = db.prepare("SELECT id, state FROM rounds WHERE id = (SELECT current_round_id FROM rooms WHERE id = ?)").get(room.id) as
      | { id: string; state: string }
      | undefined;
    db.prepare("UPDATE rooms SET state = 'expired', updated_at = ? WHERE id = ?").run(now, room.id);
    if (round && !["finished", "cancelled", "expired"].includes(round.state)) {
      db.prepare("UPDATE rounds SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(
        now,
        now,
        round.id,
      );
    }
    count += 1;
  }
  return count;
}

// Belt-and-braces sweep: any secrets left over from finished/cancelled/expired
// rounds are removed (normally purged at the transition itself).
function purgeLeftoverSecrets(db: DB): void {
  db.prepare(
    `DELETE FROM private_submissions WHERE round_id IN (
       SELECT id FROM rounds WHERE state IN ('finished','cancelled','expired'))`,
  ).run();
  db.prepare(
    `DELETE FROM private_reading_sequences WHERE round_id IN (
       SELECT id FROM rounds WHERE state IN ('finished','cancelled','expired'))`,
  ).run();
}

export function markExpiredAsDone(db: DB): void {
  db.prepare(
    "UPDATE rounds SET state = 'expired', finished_at = ? WHERE state IN ('lobby_open','collecting_words','ready_to_read','reading') AND room_id IN (SELECT id FROM rooms WHERE state = 'cancelled')",
  ).run(Date.now());
  db.prepare("UPDATE speaker_leases SET killed = 1 WHERE round_id IN (SELECT id FROM rounds WHERE state IN ('finished','cancelled','expired'))").run();
}

export function runCleanup(db: DB): { expiredRooms: number; expiredTokens: number } {
  const expiredRooms = expireInactiveRooms(db);
  purgeLeftoverSecrets(db);
  markExpiredAsDone(db);
  const expiredTokens = Number(db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(Date.now()).changes);
  return { expiredRooms, expiredTokens };
}
