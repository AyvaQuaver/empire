import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, Client, createRoomBy, joinByCode, expectOk, type TestContext } from "./harness.js";

let t: TestContext;
let base: string;

beforeAll(async () => {
  t = await startTestServer();
  base = t.base;
});
afterAll(async () => {
  await t.close();
});


// Four independent browser sessions complete a full round: join, lock,
// private submissions, duplicate rejection, readiness, three readings, random
// starter, manual winner, and idempotent result saves.
const starterFlow = async (
  c: Client,
  players: Client[],
  code: string,
  roundId: string,
) => {
  const words = WORDS;
  for (const [i, player] of players.entries()) {
    const res = await player.put(`/api/rooms/${code}/my-word`, { word: words[i] });
    expectOk(res.status, res.json, `my-word ${i}`);
  }
  const start = await c.post(`/api/rooms/${code}/reading/start`);
  expectOk(start.status, start.json, "reading/start");
  const leaseToken = start.json.leaseToken as string;
  // payload presented to the lease holder only
  const payload = await c.get(`/api/rounds/${roundId}/reading/words?reading=1`, { "x-empire-lease": leaseToken });
  expectOk(payload.status, payload.json, "payload");
  expect(payload.json.words).toHaveLength(4);
  // Each reading contains every word exactly once.
  const seen = new Set(payload.json.words as string[]);
  expect(seen.size).toBe(4);
  for (const w of words) expect(seen.has(w)).toBe(true);
  // Two starts do not regenerate the snapshot: second start is rejected.
  const again = await c.post(`/api/rooms/${code}/reading/start`);
  expect(again.status).toBe(409);
  return { leaseToken, words };
};

describe("four-player full round", () => {
  it("walks guest+account players through join → lock → words → readings → result", async () => {
    const organiser = new Client(base);
    const p2 = new Client(base);
    const p3 = new Client(base);
    const p4 = new Client(base);

    const created = await createRoomBy(organiser, "Lucy", "Animals");
    const code = created.room.code;
    const roundId = created.round.id;

    expectOk((await joinByCode(p2, code, "Sami")).status, null, "join p2");
    expectOk((await joinByCode(p3, code, "Robin")).status, null, "join p3");
    expectOk((await joinByCode(p4, code, "Tegan")).status, null, "join p4");

    // duplicate membership on repeat request: idempotent rejoin
    const again = await joinByCode(p2, code, "Sami");
    expect(again.json.reconnected).toBe(true);

    // lock requires minimum players & organiser authority — sanity then lock
    const locked = await organiser.post(`/api/rooms/${code}/lock`);
    expectOk(locked.status, locked.json, "lock");
    const lateJoin = await joinByCode(new Client(base), code, "Latecomer");
    expect(lateJoin.status).toBe(409); // roster locked

    // duplicate words (case-insensitively) are rejected, without naming a submitter
    for (const [i, player] of [organiser, p2, p3, p4].entries()) {
      const res = await player.put(`/api/rooms/${code}/my-word`, { word: WORDS[i] });
      expectOk(res.status, res.json, `word ${i}`);
    }
    const dupe = await p3.put(`/api/rooms/${code}/my-word`, { word: WORDS[1].toUpperCase() });
    expect(dupe.status).toBe(409);
    expect((dupe.json?.error?.code ?? "")).toBe("WORD_TAKEN");
    expect(JSON.stringify(dupe.json)).not.toMatch(/Sami/i);
    // their previous valid submission was not lost on the duplicate error
    const own = await p3.get(`/api/rooms/${code}/my-word`);
    expect(own.json.word).toBe(WORDS[2]);

    const read = starterFlow(organiser, [organiser, p2, p3, p4], code, roundId);

    // only the current speaker's device gets the word payload
    const p3words = await p3.get(`/api/rounds/${roundId}/reading/words?reading=1`, {
      "x-empire-lease": (await read).leaseToken,
    });
    expect(p3words.status).toBe(403);
    const noLease = await organiser.get(`/api/rounds/${roundId}/reading/words?reading=1`);
    expect(noLease.status).toBe(403);

    // finish 3 readings via acks/completes
    const leaseToken = (await read).leaseToken;
    for (let n = 1; n <= 3; n++) {
      const ack = await organiser.post(`/api/rounds/${roundId}/reading/ack`, {
        leaseToken,
        readingNumber: n,
        position: 4,
      });
      expectOk(ack.status, ack.json, "ack");
      const done = await organiser.post(`/api/rounds/${roundId}/reading/complete`, { leaseToken, readingNumber: n });
      expectOk(done.status, done.json, "complete");
      if (n < 3) expect(done.json.playingNow).toBe(false);
      else expect(done.json.playingNow).toBe(true);
    }
    // acks after completion are rejected (monotonic fencing)
    const staleAck = await organiser.post(`/api/rounds/${roundId}/reading/ack`, {
      leaseToken,
      readingNumber: 3,
      position: 2,
    });
    expect(staleAck.status).toBe(403);

    // starter announced from the locked roster
    const state = await p4.get(`/api/rooms/${code}/state`);
    expect(state.json.snapshot.round.state).toBe("playing");
    const starterName = state.json.snapshot.starter?.displayName as string;
    expect(["Lucy", "Sami", "Robin", "Tegan"]).toContain(starterName);

    // non-organiser cannot record the winner
    const forbiddenSave = await p3.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: "whatever" });
    expect(forbiddenSave.status).toBe(403);

    // organiser records winner; repeated saves are idempotent
    const save1 = await organiser.post(`/api/rounds/${roundId}/result`, {
      winnerPlayerId: state.json.snapshot.players[1].playerId,
    });
    expectOk(save1.status, save1.json, "save result");
    const roundsFinished1 = await organiser.get("/api/me/history");
    void roundsFinished1;

    const saveAgain = await organiser.post(`/api/rounds/${roundId}/result`, {
      winnerPlayerId: state.json.snapshot.players[1].playerId,
    });
    expectOk(saveAgain.status, saveAgain.json, "repeat save");

    // words deleted after finish
    const myWord = await organiser.get(`/api/rooms/${code}/my-word`);
    expect(myWord.json.word).toBeNull();

    // correction moves the win, keeping one game
    const correction = await organiser.post(`/api/rounds/${roundId}/result`, {
      winnerPlayerId: state.json.snapshot.players[2].playerId,
    });
    expectOk(correction.status, correction.json, "correction");
    const resultView = await p2.get(`/api/rooms/${code}/state`);
    expect(resultView.json.snapshot.result.winnerName).toBe(resultView.json.snapshot.players[2].displayName);

    // Play another round: fresh round, no previous secrets
    const next = await organiser.post(`/api/rounds/${roundId}/next-round`);
    expectOk(next.status, next.json, "next round");
    const fresh = await p2.get(`/api/rooms/${code}/state`);
    expect(fresh.json.snapshot.round.seq).toBe(2);
    expect(fresh.json.snapshot.round.state).toBe("lobby_open");
  }, 30000);
});

const WORDS = ["anchor", "beacon", "cornfield", "dusk"];
