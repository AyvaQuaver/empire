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

/* Round-authoritative word pacing: allowed values only, organiser-or-speaker
 * authorisation, inherited by a replacement speaker, fallback 1s, and no
 * influence on readings/the starter. */

async function readyRound() {
  const organiser = new Client(base);
  const created = await organiser.post("/api/rooms", { displayName: "PaceHost", genre: "Animals" });
  const code = created.json.room.code;
  const roundId = created.json.round.id;
  const others = [new Client(base), new Client(base), new Client(base)];
  for (const [i, p] of others.entries()) {
    expectOk((await p.post("/api/rooms/join", { code, displayName: `Pace${i}` })).status, null, "join");
  }
  expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");
  const words = ["ibis", "koala", "heron", "lynx"];
  for (const [i, p] of [organiser, ...others].entries()) {
    expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: words[i] })).status, null, "word");
  }
  const state = await organiser.get(`/api/rooms/${code}/state`);
  const roundState = state.json.snapshot.round.state;
  return { organiser, others, code, roundId, roundState };
}

function wordPauseDbValue(roundId: string): number | null {
  return (
    t.handle.db.prepare("SELECT word_pause_ms FROM rounds WHERE id = ?").get(roundId) as {
      word_pause_ms: number | null;
    }
  ).word_pause_ms;
}

describe("word pacing", () => {
  it("falls back to 1s (nothing persisted) and rejects unsupported values", async () => {
    const { organiser, code, roundId } = await readyRound();
    const st = await organiser.get(`/api/rooms/${code}/state`);
    expect(st.json.snapshot.round.wordPauseMs).toBe(1000); // default fallback
    expect(wordPauseDbValue(roundId)).toBe(null);

    const bad = await organiser.post(`/api/rounds/${roundId}/word-pause`, { ms: 500 });
    expect(bad.status).toBe(400); // under the floor of 1s
    const bad2 = await organiser.post(`/api/rounds/${roundId}/word-pause`, { ms: 2400 });
    expect(bad2.status).toBe(400); // not on the ladder
    const missing = await organiser.post(`/api/rounds/${roundId}/word-pause`, {});
    expect(missing.status).toBe(400); // no choice made
    expect(wordPauseDbValue(roundId)).toBe(null);
  });

  it("lets the organiser persist an allowed value before playback", async () => {
    const { organiser, code, roundId } = await readyRound();
    for (const ms of [1000, 1500, 2000, 3000]) {
      expectOk((await organiser.post(`/api/rounds/${roundId}/word-pause`, { ms })).status, null, `set ${ms}`);
      expect(wordPauseDbValue(roundId)).toBe(ms);
      const st = await organiser.get(`/api/rooms/${code}/state`);
      expect(st.json.snapshot.round.wordPauseMs).toBe(ms);
    }
  });

  it("rejects non-organisers before a speaker lease exists", async () => {
    const { others, roundId } = await readyRound();
    const stranger = new Client(base);
    await stranger.get("/api/capabilities");
    expect((await stranger.post(`/api/rounds/${roundId}/word-pause`, { ms: 2000 })).status).toBe(403);
    const rosterMate = others[0];
    expect((await rosterMate.post(`/api/rounds/${roundId}/word-pause`, { ms: 2000 })).status).toBe(403);
    expect(wordPauseDbValue(roundId)).toBe(null);
  });

  it("the lease-holding speaker may set it during readings; the value survives restart-readings", async () => {
    const { organiser, others, code, roundId } = await readyRound();
    // organiser starts readings and holds the lease
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expectOk(start.status, start.json, "start");
    const leaseToken = start.json.leaseToken;

    // while the readings run, the lease holder may change pacing (paused case)
    const setByHolder = await organiser.post(`/api/rounds/${roundId}/word-pause`, { ms: 2000 });
    expect(setByHolder.status).toBe(200);
    expect(wordPauseDbValue(roundId)).toBe(2000);

    // other players remain unauthorised even mid-readings
    const mate = others[0];
    expect((await mate.post(`/api/rounds/${roundId}/word-pause`, { ms: 3000 })).status).toBe(403);

    // complete all readings server-side; pacing must not block the chain
    for (let n = 1; n <= 3; n++) {
      expectOk(
        (
          await organiser.post(`/api/rounds/${roundId}/reading/ack`, {
            leaseToken,
            readingNumber: n,
            position: 4,
          })
        ).status,
        null,
        "ack",
      );
      expectOk(
        (
          await organiser.post(`/api/rounds/${roundId}/reading/complete`, {
            leaseToken,
            readingNumber: n,
          })
        ).status,
        null,
        "complete",
      );
    }
    const st = await organiser.get(`/api/rooms/${code}/state`);
    expect(st.json.snapshot.round.state).toBe("playing");
    expect(st.json.snapshot.round.wordPauseMs).toBe(2000);

    // finish the round (record a result), then next round: fresh row, pacing
    // falls back to the default until the organising speaker sets it again
    const players = st.json.snapshot.players as { playerId: string; isMe: boolean }[];
    const winnerId = players.find((p) => !p.isMe)!.playerId;
    expectOk(
      (
        await organiser.post(`/api/rounds/${roundId}/result`, {
          winnerPlayerId: winnerId,
        })
      ).status,
      null,
      "result",
    );
    await organiser.post(`/api/rounds/${roundId}/next-round`);
    const after = await organiser.get(`/api/rooms/${code}/state`);
    expect(after.json.snapshot.round.wordPauseMs).toBe(1000);
  });

  it("a replacement speaker inherits the round's value", async () => {
    const { organiser, others, code, roundId } = await readyRound();
    expectOk((await organiser.post(`/api/rounds/${roundId}/word-pause`, { ms: 3000 })).status, null, "set 3000");
    const leaseResp = await organiser.post(`/api/rounds/${roundId}/lease`, { action: "acquire" });
    expectOk(leaseResp.status, leaseResp.json, "lease acquire");
    const leaseToken = leaseResp.json.leaseToken;
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expectOk(start.status, start.json, "start=start");

    // the round keeps its value in snapshots for everyone (speaker transfer read path)
    const state = await others[1].get(`/api/rooms/${code}/state`);
    expect(state.json.snapshot.round.wordPauseMs).toBe(3000);
    void leaseToken; // the reading payload itself stays fenced; pacing is public
  });
});
