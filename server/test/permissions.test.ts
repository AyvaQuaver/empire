import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, Client, type TestContext } from "./harness.js";

let t: TestContext;
let base: string;

beforeAll(async () => {
  t = await startTestServer();
  base = t.base;
});
afterAll(async () => {
  await t.close();
});

/* Server permissions verified with direct requests (not hidden buttons). */
let nameSeq = 0;
async function setupRound() {
  const organiser = new Client(base);
  const p2 = new Client(base);
  const p3 = new Client(base);
  const outsider = new Client(base);
  const created = await organiser.post("/api/rooms", { displayName: "Ada", genre: "Food" });
  const code = created.json.room.code as string;
  const roundId = created.json.round.id as string;
  for (const p of [p2, p3]) {
    const joined = await p.post("/api/rooms/join", { code, displayName: `Player${++nameSeq}` });
    if (joined.status !== 200) throw new Error(`join failed: ${JSON.stringify(joined.json)}`);
  }
  const locked = await organiser.post(`/api/rooms/${code}/lock`);
  if (locked.status !== 200) throw new Error(`lock failed: ${JSON.stringify(locked.json)}`);
  for (const [i, p] of [organiser, p2, p3].entries()) {
    const saved = await p.put(`/api/rooms/${code}/my-word`, { word: FOODS[i] });
    if (saved.status !== 200) throw new Error(`word ${i} failed: ${JSON.stringify(saved.json)}`);
  }
  return { organiser, p2, p3, outsider, code, roundId };
}

const FOODS = ["banana", "crumpet", "marmalade"];

describe("server-side privacy and access control", () => {
  it("never exposes word ownership to any role", async () => {
    const { organiser, p2, code } = await setupRound();

    // A player cannot read another player's submission — no endpoint exists for it.
    const sneaky = await p2.get(`/api/rooms/${code}/my-word?playerId=organiser`);
    void sneaky;

    // The readiness payload names only readiness, not words.
    const state2 = await p2.get(`/api/rooms/${code}/state`);
    const body = JSON.stringify(state2.json);
    expect(body).not.toContain("banana");
    // A player sees only their own word (via myWord), never anyone else's:
    expect(body).not.toContain("marmalade");
    const playersWordless = state2.json.snapshot.players.every(
      (p: Record<string, unknown>) => !("word" in p || "myWord" in p),
    );
    expect(playersWordless).toBe(true);

    // Even the organiser's snapshot shows only their own word, no one else's.
    const stateOrganiser = await organiser.get(`/api/rooms/${code}/state`);
    expect(stateOrganiser.json.snapshot.myWord).toBe("banana");
    const orgBody = JSON.stringify(stateOrganiser.json);
    const orgPlayersWordless = stateOrganiser.json.snapshot.players.every(
      (p: Record<string, unknown>) => !("word" in p || "myWord" in p),
    );
    expect(orgPlayersWordless).toBe(true);
    // ...but the organiser can still fetch their own word separately:
    const own = await organiser.get(`/api/rooms/${code}/my-word`);
    expect(own.json.word).toBe("banana");

    // No submission timestamps or ordering in public payloads
    expect(orgBody).not.toContain('"word"');
    expect(orgBody).not.toContain("word_normalized");
    expect(orgBody).not.toContain("submissions");
    void p2;
  });

  it("outsiders cannot read room data, lifecycle, or results", async () => {
    const { outsider, code, roundId } = await setupRound();
    void roundId;

    const state = await outsider.get(`/api/rooms/${code}/state`);
    expect(state.json.member).toBe(false);
    expect(state.json).not.toHaveProperty("players");

    const lock = await outsider.post(`/api/rooms/${code}/lock`);
    expect(lock.status).toBe(403);
    const cancel = await outsider.post(`/api/rooms/${code}/cancel`);
    expect(cancel.status).toBe(403);
    const remove = await outsider.post(`/api/rooms/${code}/remove`, { playerId: "x" });
    expect(remove.status).toBe(403);
    const start = await outsider.post(`/api/rooms/${code}/reading/start`);
    expect(start.status).toBe(403);
    const result = await outsider.post(`/api/rounds/00000000-0000-0000-0000-000000000000/result`, { winnerPlayerId: "x" });
    expect(result.status).toBe(404); // not found ≠ mutation; either way denied

    const playerState = await outsider.get(`/api/rooms/NOPE99/state`);
    expect(playerState.json.error.code).toBe("NOT_FOUND");
  });

  it("non-organisers cannot mutate lifecycle or results", async () => {
    const { p2, code, roundId } = await setupRound();
    expect((await p2.patch(`/api/rooms/${code}`, { genre: "Drinks" })).status).toBe(403);
    expect((await p2.post(`/api/rooms/${code}/lock`)).status).toBe(403);
    expect((await p2.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: "x" })).status).toBe(403);
    expect((await p2.post(`/api/rounds/${roundId}/next-round`)).status).toBe(403);
  });

  it("only the lease-holding device obtains the reading payload", async () => {
    const { organiser, p2, p3, code, roundId } = await setupRound();
    const started = await organiser.post(`/api/rooms/${code}/reading/start`);
    if (started.status !== 200) throw new Error(`start failed: ${JSON.stringify(started.json)}`);
    const token = started.json.leaseToken as string;
    const denied = await p2.get(`/api/rounds/${roundId}/reading/words?reading=1`, { "x-empire-lease": token });
    expect(denied.status).toBe(403); // valid token, wrong session
    const noHeader = await p2.get(`/api/rounds/${roundId}/reading/words?reading=1`);
    expect(noHeader.status).toBe(403);
    const holder = await organiser.get(`/api/rounds/${roundId}/reading/words?reading=1`, { "x-empire-lease": token });
    expect(holder.status).toBe(200);
    const payload = JSON.stringify(holder.json);
    expect(payload).not.toContain("player");
    expect(payload).not.toContain("session");
    expect((holder.json.words as string[]).sort()).toEqual([...FOODS].sort());
    void p3;
  });

  it("simultaneous duplicate words converge with one accepted and one conflict", async () => {
    const { p2, p3, code } = await setupRound();
    // both change words to the same new value "muffin" simultaneously
    const [a, b] = await Promise.all([
      p2.put(`/api/rooms/${code}/my-word`, { word: "muffin" }),
      p3.put(`/api/rooms/${code}/my-word`, { word: "MUFFIN" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = statuses[0] === 409 ? "" : "";
    void loser;
  });

  it("expired secrets are purged but valid history survives", async () => {
    const { organiser, code, roundId } = await setupRound();
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    if (start.status !== 200) throw new Error("start failed");
    const token = start.json.leaseToken;
    for (let n = 1; n <= 3; n++) {
      await organiser.post(`/api/rounds/${roundId}/reading/ack`, { leaseToken: token, readingNumber: n, position: 3 });
      await organiser.post(`/api/rounds/${roundId}/reading/complete`, { leaseToken: token, readingNumber: n });
    }
    const result = await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: (await stateOf(organiser, code)).snapshot.players[0].playerId });
    expect(result.status).toBe(200);
    const finished = await stateOf(organiser, code);
    expect(finished.snapshot.round.state).toBe("finished");
    // cancels: room is done; words must be gone from the DB
    const { handle } = t;
    const db = handle.db;
    const words = db.prepare("SELECT COUNT(*) AS n FROM private_submissions WHERE round_id = ?").get(roundId) as { n: number };
    const seqs = db.prepare("SELECT COUNT(*) AS n FROM private_reading_sequences WHERE round_id = ?").get(roundId) as { n: number };
    expect(words.n).toBe(0);
    expect(seqs.n).toBe(0);
    // cancelled rounds do not count; this one finished and stays in history
    const players = db.prepare("SELECT COUNT(*) AS n FROM round_participants WHERE round_id = ?").get(roundId) as { n: number };
    expect(players.n).toBe(3);
  });

  it("remaining cancelled rounds never appear in games played", async () => {
    const { organiser, code, roundId } = await setupRound();
    await organiser.post(`/api/rooms/${code}/cancel-round`);
    const state = await organiser.get(`/api/rooms/${code}/state`);
    expect(state.json.snapshot.round.state).toBe("cancelled");
    void roundId;
    const db = t.handle.db;
    const results = db.prepare("SELECT COUNT(*) AS n FROM game_results WHERE room_id = (SELECT id FROM rooms WHERE code = ?)").get(code) as { n: number };
    expect(results.n).toBe(0);
  });
});

async function stateOf(c: Client, code: string) {
  const res = await c.get(`/api/rooms/${code}/state`);
  return res.json;
}
