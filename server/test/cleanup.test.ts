import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, Client, type TestContext } from "./harness.js";
import { runCleanup } from "../src/services/cleanup.js";

let t: TestContext;
let base: string;

beforeAll(async () => {
  t = await startTestServer();
  base = t.base;
});
afterAll(async () => {
  await t.close();
});

/* Retention: expired secrets are actually removed while valid history survives;
 * abandoned rounds purge within the inactivity window; active rooms don't. */
describe("retention & cleanup", () => {
  it("purges abandoned rounds after inactivity without touching active ones", async () => {
    const active = new Client(base);
    const room = await active.post("/api/rooms", { displayName: "Keeper", genre: "Food" });
    const activeCode = room.json.room.code;
    await active.put(`/api/rooms/${activeCode}/my-word`, { word: "pastry" });

    const abandoned = new Client(base);
    const old = await abandoned.post("/api/rooms", { displayName: "OldHost", genre: "Films" });
    const oldCode = old.json.room.code;
    await abandoned.put(`/api/rooms/${oldCode}/my-word`, { word: "western" });
    void new Client(base);

    // simulate inactivity age
    const cutoff = Date.now() - 25 * 3600 * 1000;
    t.handle.db.prepare("UPDATE rooms SET last_activity_at = ? WHERE code = ?").run(cutoff, oldCode);

    const out = runCleanup(t.handle.db);
    expect(out.expiredRooms).toBe(1);

    const db = t.handle.db;
    const activeWords = db
      .prepare("SELECT COUNT(*) AS n FROM rooms WHERE code = ? AND state = 'open'")
      .get(activeCode) as { n: number };
    expect(activeWords.n).toBe(1);
    const oldWords = db
      .prepare(
        "SELECT COUNT(*) AS n FROM private_submissions s JOIN rounds r ON r.id = s.round_id WHERE r.room_id = (SELECT id FROM rooms WHERE code = ?)",
      )
      .get(oldCode) as { n: number };
    expect(oldWords.n).toBe(0);
    const oldState = db.prepare("SELECT state FROM rooms WHERE code = ?").get(oldCode) as { state: string };
    expect(oldState.state).toBe("expired");
  });

  it("finished round keeps participants/history but drops words & sequences", async () => {
    const db = t.handle.db;
    // construct directly: a finished round with a stale secret
    const { randomId } = await import("../src/ids.js");
    const roomId = randomId();
    const now = Date.now();
    db.prepare(
      "INSERT INTO rooms (id, code, title, genre, state, invitation_token, created_at, updated_at, last_activity_at) VALUES (?, 'DONEAA', 'Done', 'Games', 'open', 'tok-done', ?, ?, ?)",
    ).run(roomId, now, now, now);
    const roundId = randomId();
    db.prepare(
      "INSERT INTO rounds (id, room_id, seq, state, genre, title, created_at, updated_at, finished_at) VALUES (?, ?, 1, 'finished', 'Games', 'Done', ?, ?, ?)",
    ).run(roundId, roomId, now, now, now);
    // private rows always belong to real players (FK); a stale one lingers on.
    const stalePlayerId = "p-stale-finished";
    db.prepare(
      "INSERT INTO players (id, room_id, session_id, user_id, display_name, display_name_canonical, join_order, is_organiser, status, created_at, last_seen_at) VALUES (?, ?, NULL, NULL, 'Stale', 'stale', 1, 0, 'left', ?, ?)",
    ).run(stalePlayerId, roomId, now, now);
    db.prepare("INSERT INTO private_submissions (round_id, player_id, word_display, word_normalized, created_at, updated_at) VALUES (?, ?, 'leftover', 'leftover', ?, ?)").run(roundId, stalePlayerId, now, now);
    db.prepare("INSERT INTO private_reading_sequences (round_id, reading_number, words_json) VALUES (?, 1, '[\"leftover\"]')").run(roundId);

    const out = runCleanup(db);
    expect(out.expiredRooms).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM private_submissions WHERE round_id = ?").get(roundId) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM private_reading_sequences WHERE round_id = ?").get(roundId) as { n: number }).n).toBe(0);
  });
});
