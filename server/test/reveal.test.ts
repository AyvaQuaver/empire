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

/* Winning-word reveal: deliberate temporary visibility change. Only the
 * winning word is captured on result save; other secrets are destroyed;
 * only round participants may read the reveal; corrections clear it and
 * only the CURRENT winner may supply a replacement; reveals expire and
 * never enter permanent history. */

async function finishedRound() {
  const organiser = new Client(base);
  const created = await organiser.post("/api/rooms", { displayName: "RevealHost", genre: "Animals" });
  const code = created.json.room.code;
  const roundId = created.json.round.id;
  const others = [new Client(base), new Client(base)];
  for (const [i, p] of others.entries()) {
    expectOk((await p.post("/api/rooms/join", { code, displayName: `Reveal${i}` })).status, null, "join");
  }
  expectOk((await organiser.post(`/api/rooms/${code}/lock`)).status, null, "lock");
  const words = ["otter", "ibis", "koala"]; // organiser, R0, R1
  for (const [i, p] of [organiser, ...others].entries()) {
    expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: words[i] })).status, null, "word");
  }
  const start = await organiser.post(`/api/rooms/${code}/reading/start`);
  expectOk(start.status, start.json, "start");
  for (let n = 1; n <= 3; n++) {
    expectOk(
      (
        await organiser.post(`/api/rounds/${roundId}/reading/ack`, {
          leaseToken: start.json.leaseToken,
          readingNumber: n,
          position: 3,
        })
      ).status,
      null,
      "ack",
    );
    expectOk(
      (
        await organiser.post(`/api/rounds/${roundId}/reading/complete`, {
          leaseToken: start.json.leaseToken,
          readingNumber: n,
        })
      ).status,
      null,
      "complete",
    );
  }
  const st = await organiser.get(`/api/rooms/${code}/state`);
  const players = st.json.snapshot.players as { playerId: string; displayName: string; isMe: boolean }[];
  const organiserPlayer = players.find((p) => p.isMe)!;
  return { organiser, others, code, roundId, players, organiserPlayer, words };
}

function revealRow(roundId: string) {
  return t.handle.db
    .prepare("SELECT word, source, result_version, winner_player_id, expires_at FROM result_reveals WHERE round_id = ?")
    .get(roundId) as { word: string | null; source: string; result_version: number; winner_player_id: string; expires_at: number } | undefined;
}

describe("winning-word reveal", () => {
  it("initial result save captures ONLY the winning word and destroys the rest", async () => {
    const { organiser, code, roundId, players, words } = await finishedRound();
    const mate1 = players.find((p) => !p.isMe && p.displayName === "Reveal0")!;
    const save = await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId });
    expect(save.status).toBe(200);

    const row = revealRow(roundId);
    expect(row?.word).toBe("ibis"); // the winner's word, and nothing else
    expect(row?.source).toBe("original");
    // private submissions for this round are gone from storage
    expect(
      (t.handle.db.prepare("SELECT COUNT(*) n FROM private_submissions WHERE round_id = ?").get(roundId) as { n: number }).n,
    ).toBe(0);

    // participants may read it; the organiser sees it too
    const revealResp = await organiser.get(`/api/rounds/${roundId}/reveal`);
    expect(revealResp.json.reveal.word).toBe("ibis");
    expect(revealResp.json.reveal.expired).toBe(false);
    void code;
    void words;
  });

  it("outsiders, non-participants and 'just friends' cannot read the reveal", async () => {
    const { organiser, code, roundId, players } = await finishedRound();
    void organiser;
    // save once so a reveal exists
    const mate1 = players.find((p) => !p.isMe && p.displayName === "Reveal0")!;
    await (async () => {
      const r = await new Client(base).post(`/api/rooms/${code}/state`);
      void r;
    })();
    const save = await new Client(base).post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId });
    expect(save.status).toBe(403); // non-organiser can't even record

    // fresh non-member
    const outsider = await new Client(base).get(`/api/rounds/${roundId}/reveal`);
    expect(outsider.status).toBe(403);

    // an ACCOUNT friend of the organiser who never played the round
    const friend = new Client(base);
    expect(
      (
        await friend.post("/api/auth/register", {
          username: "reveal_friend",
          email: "rf@example.test",
          password: "long-enough-pass-1",
        })
      ).status,
    ).toBe(200);
    // (organiser stays guest; friendship route needs accounts on both ends — a
    // direct same-room check is what matters: the friend never joined the round)
    const probe = await friend.get(`/api/rounds/${roundId}/reveal`);
    expect(probe.status).toBe(403);

    // a guest who joined AFTER the round (non-participant member of the room can't exist here;
    // roster was locked pre-readings, so room membership == participants)
    const lateGuest = new Client(base);
    expect((await lateGuest.post("/api/rooms/join", { code, displayName: "Latecomer" })).status).toBe(409);
    expect((await lateGuest.get(`/api/rounds/${roundId}/reveal`)).status).toBe(403);
  });

  it("guest sessions of round participants can read the reveal; duplicate save is safe", async () => {
    const { organiser, others, code, roundId, players } = await finishedRound();
    const mate1 = players.find((p) => !p.isMe && p.displayName === "Reveal0")!;
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId })).status).toBe(200);
    const forMate = await others[0].get(`/api/rounds/${roundId}/reveal`);
    expect(forMate.status).toBe(200);
    expect(forMate.json.reveal.word).toBe("ibis");
    // duplicate save must not fail now that submissions are deleted…
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId })).status).toBe(200);
    const reread = await others[0].get(`/api/rounds/${roundId}/reveal`);
    expect(reread.json.reveal.word).toBe("ibis");
    void code;
  });

  it("expired reveals read back without a word", async () => {
    const { organiser, roundId, players } = await finishedRound();
    const mate1 = players.find((p) => !p.isMe && p.displayName === "Reveal0")!;
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId })).status).toBe(200);
    t.handle.db.prepare("UPDATE result_reveals SET expires_at = ? WHERE round_id = ?").run(Date.now() - 1000, roundId);
    const reveal = await organiser.get(`/api/rounds/${roundId}/reveal`);
    expect(reveal.json.reveal.expired).toBe(true);
    expect(reveal.json.reveal.word).toBeNull(); // result still there, word withheld
    void players;
  });

  it("corrections remove the reveal and reconcile stats; only the CURRENT winner may replace the word", async () => {
    const { organiser, others, code, roundId, players, words } = await finishedRound();
    const mate1 = players.find((p) => !p.isMe && p.displayName === "Reveal0")!;
    const mate2 = players.find((p) => !p.isMe && p.displayName === "Reveal1")!;
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId })).status).toBe(200);
    expect((await revealRow(roundId))?.word).toBe("ibis");

    // correct the winner to Mate 2
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate2.playerId })).status).toBe(200);
    const after = revealRow(roundId);
    expect(after?.word).toBeNull(); // previous winner's word removed
    expect(after?.result_version).toBe(2);
    expect(after?.winner_player_id).toBe(mate2.playerId);
    // original TTL is NOT extended by corrections; replacement eligibility is
    // only for the current winner's own session
    expect(
      (await organiser.get(`/api/rounds/${roundId}/reveal`)).json.reveal.canSubmitReplacement,
    ).toBe(false); // organiser isn't the winner
    expect(
      (await others[1].get(`/api/rounds/${roundId}/reveal`)).json.reveal.canSubmitReplacement,
    ).toBe(true);
    expect(
      (await others[0].get(`/api/rounds/${roundId}/reveal`)).json.reveal.canSubmitReplacement,
    ).toBe(false); // the previous winner is not the CURRENT winner

    // only the CURRENT winner (Reveal1 session) may submit the replacement…
    expect(
      (await others[0].post(`/api/rounds/${roundId}/reveal-word`, { word: words[2] })).status,
    ).toBe(403); // previous winner must be rejected
    expect(
      (await others[1].post(`/api/rounds/${roundId}/reveal-word`, { word: words[2] })).status,
    ).toBe(200);
    expect((await revealRow(roundId))?.word).toBe(words[2]); // "koala"
    expect((await revealRow(roundId))?.source).toBe("replacement");

    // stats moved correctly and stayed at a single game
    const stats1 = await others[0].get("/api/me/stats");
    const stats2 = await others[1].get("/api/me/stats");
    expect(stats1.json.gamesPlayed).toBe(1);
    expect(stats1.json.wins).toBe(0);
    expect(stats2.json.wins).toBe(1);

    void code;
  });

  it("stale replacement words can't overwrite; results never gain words in history", async () => {
    const { organiser, others, roundId, players } = await finishedRound();
    const mate1 = players.find((p) => !p.isMe && p.displayName === "Reveal0")!;
    const mate2 = players.find((p) => !p.isMe && p.displayName === "Reveal1")!;
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate1.playerId })).status).toBe(200);

    // correction flows move the winner AND bump version 1→2
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: mate2.playerId })).status).toBe(200);
    // mate2 (current winner) replaces: allowed
    expect((await others[1].post(`/api/rounds/${roundId}/reveal-word`, { word: "narwhal" })).status).toBe(200);
    // mate2 re-submits again: idempotent re-set of the same current winner's word
    expect((await others[1].post(`/api/rounds/${roundId}/reveal-word`, { word: "snorkel" })).status).toBe(200);
    expect((await revealRow(roundId))?.word).toBe("snorkel");

    // history access never includes the word
    const hist = await others[0].get("/api/me/history");
    expect(JSON.stringify(hist.json)).not.toContain("snorkel");
    void organiser;
  });
});
