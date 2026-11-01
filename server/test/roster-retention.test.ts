import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, Client, expectOk, type TestContext } from "./harness.js";

let t: TestContext;
let base: string;

beforeAll(async () => {
  t = await startTestServer();
  base = t.base;
});
afterAll(async () => {
  await t.close();
});

/* Roster churn (remove/leave), room cancellation joins, per-round secret
 * retention, and result correction bookkeeping. */

async function roomWith(c: Client, n: number) {
  const created = await c.post("/api/rooms", { displayName: "Host", genre: "Food" });
  expectOk(created.status, created.json, "create");
  const code = created.json.room.code;
  const roundId = created.json.round.id;
  const others: Client[] = [];
  for (let i = 0; i < n; i++) {
    const p = new Client(base);
    expectOk((await p.post("/api/rooms/join", { code, displayName: `Mate${i + 1}` })).status, null, "join");
    others.push(p);
  }
  return { code, roundId, others };
}

async function state(c: Client, code: string) {
  return (await c.get(`/api/rooms/${code}/state`)).json;
}

describe("roster churn & retention", () => {
  it("removing players recomputes readiness; below minimum blocks start", async () => {
    const organiser = new Client(base);
    const { code, roundId, others } = await roomWith(organiser, 3);
    const players = [organiser, ...others];
    expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");

    const words = ["fig", "ginger", "hazelnut", "icing"];
    for (const [i, p] of players.entries()) {
      expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: words[i] })).status, null, "word");
    }
    expect((await state(players[0], code)).snapshot.round.state).toBe("ready_to_read");

    // Removing a submitted player deletes their word and readiness recomputes.
    const removed = (await state(organiser, code)).snapshot.players.find((p: any) => p.displayName === "Mate3");
    expectOk((await organiser.post(`/api/rooms/${code}/remove`, { playerId: removed.playerId })).status, null, "remove");
    const after = await state(players[0], code);
    expect(after.snapshot.readiness).toEqual({ ready: 3, total: 3 });
    expect(after.snapshot.round.state).toBe("ready_to_read"); // still ≥3 total

    // Their secret didn't survive the removal.
    const db = t.handle.db;
    const stale = db
      .prepare("SELECT COUNT(*) AS n FROM private_submissions WHERE round_id = ? AND player_id = ?")
      .get(roundId, removed.playerId) as { n: number };
    expect(stale.n).toBe(0);

    // Removing one more drops the roster below the game minimum → start blocked.
    const removed2 = (await state(organiser, code)).snapshot.players.find((p: any) => p.displayName === "Mate2");
    expectOk((await organiser.post(`/api/rooms/${code}/remove`, { playerId: removed2.playerId })).status, null, "remove");
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expect(start.status).toBe(409);
    expect(start.json.error.code).toBe("TOO_FEW_PLAYERS");
  });

  it("leaving before readings recomputes readiness (above minimum still readies)", async () => {
    const organiser = new Client(base);
    const { code, others } = await roomWith(organiser, 3);
    const players = [organiser, ...others];
    expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");
    for (const [i, p] of players.entries()) {
      expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: ["jam", "kale", "lemon", "miso"][i] })).status, null, "word");
    }
    // A non-organiser leaves; their word is dropped with them.
    expectOk((await others[0].post(`/api/rooms/${code}/leave`)).status, null, "leave");
    const after = await state(players[0], code);
    expect(after.snapshot.readiness).toEqual({ ready: 3, total: 3 });
    expect(after.snapshot.round.state).toBe("ready_to_read");
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expect(start.status).toBe(200);
  });

  it("cancelled game refuses fresh joins and purges its secrets", async () => {
    const organiser = new Client(base);
    const { code, roundId } = await roomWith(organiser, 2);
    expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");
    expectOk((await organiser.put(`/api/rooms/${code}/my-word`, { word: "nutmeg" })).status, null, "word");
    expectOk((await organiser.post(`/api/rooms/${code}/cancel`)).status, null, "cancel");

    // A brand-new player cannot join a cancelled game.
    const late = await new Client(base).post("/api/rooms/join", { code, displayName: "LateLisk" });
    expect(late.status).toBe(410);

    // Secrets are gone from storage; nothing leaks through state either.
    const db = t.handle.db;
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM private_submissions WHERE round_id = ?").get(roundId) as { n: number }).n,
    ).toBe(0);
    const st = await state(organiser, code);
    expect(JSON.stringify(st)).not.toContain("nutmeg");
  });

  it("play another round keeps the group with fresh secrets and per-round uniqueness", async () => {
    const organiser = new Client(base);
    const { code, roundId, others } = await roomWith(organiser, 2);
    const players = [organiser, ...others];
    expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");
    for (const [i, p] of players.entries()) {
      expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: ["opal", "pear", "quince"][i] })).status, null, "word");
    }
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expectOk(start.status, start.json, "start");
    for (let n = 1; n <= 3; n++) {
      expectOk((await organiser.post(`/api/rounds/${roundId}/reading/ack`, { leaseToken: start.json.leaseToken, readingNumber: n, position: 3 })).status, null, "ack");
      expectOk((await organiser.post(`/api/rounds/${roundId}/reading/complete`, { leaseToken: start.json.leaseToken, readingNumber: n })).status, null, "complete");
    }
    const winner = (await state(organiser, code)).snapshot.players[1];
    expectOk((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: winner.playerId })).status, null, "result");

    const next = await organiser.post(`/api/rounds/${roundId}/next-round`);
    expectOk(next.status, next.json, "next-round");
    expect(next.json.round.seq).toBe(2);
    expect(next.json.round.state).toBe("lobby_open");

    // Old round's secrets are retained-history only: words purged from storage.
    const db = t.handle.db;
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM private_submissions WHERE round_id = ?").get(roundId) as { n: number }).n,
    ).toBe(0);

    // Lock round 2 again — word entry only accepts words once the roster is locked.
    expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock 2");
    // The same word is fine in a NEW round (uniqueness is per-round).
    expectOk((await players[1].put(`/api/rooms/${code}/my-word`, { word: "opal" })).status, null, "reuse word");
  });

  it("result corrections keep one game and move the win (guest stats)", async () => {
    const organiser = new Client(base);
    const { code, roundId, others } = await roomWith(organiser, 2);
    const players = [organiser, ...others];
    expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");
    for (const [i, p] of players.entries()) {
      expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: ["vanilla", "walnut", "yogurt"][i] })).status, null, "word");
    }
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expectOk(start.status, start.json, "start");
    for (let n = 1; n <= 3; n++) {
      expectOk((await organiser.post(`/api/rounds/${roundId}/reading/ack`, { leaseToken: start.json.leaseToken, readingNumber: n, position: 3 })).status, null, "ack");
      expectOk((await organiser.post(`/api/rounds/${roundId}/reading/complete`, { leaseToken: start.json.leaseToken, readingNumber: n })).status, null, "complete");
    }
    const win0 = (await state(organiser, code)).snapshot.players[0];
    const win1 = (await state(organiser, code)).snapshot.players[1];

    expectOk((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: win0.playerId })).status, null, "result");
    const mateStats = await others[0].get("/api/me/stats");
    expect(mateStats.json.gamesPlayed).toBe(1);
    expect(mateStats.json.wins).toBe(0); // the organiser won this round

    // Correcting does not create a second game.
    expectOk((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: win1.playerId })).status, null, "correction");
    const mateAfter = await others[0].get("/api/me/stats");
    expect(mateAfter.json.gamesPlayed).toBe(1);
    expect(mateAfter.json.wins).toBe(1);
    const hostView = (await state(organiser, code)).snapshot.result.winnerName;
    expect(hostView).toBe(win1.displayName);
  });
});
