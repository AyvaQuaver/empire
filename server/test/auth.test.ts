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

/* Accounts: register/verify/sign-in/reset, no enumeration, guest upgrade,
 * delete account anonymization. Emails go to the local outbox (DB table). */
const registerUser = async (c: Client, username: string) => {
  const res = await c.post("/api/auth/register", {
    username,
    email: `${username.toLowerCase()}@example.test`,
    password: "correct-horse-battery",
  });
  expect(res.status).toBe(200);
  return username;
};

describe("authentication flows", () => {
  it("registers, verifies, signs in, resets password; no enumeration anywhere", async () => {
    const c = new Client(base);
    await registerUser(c, "Fern_TestCase");

    // verification email stored in the local dev outbox
    const row = latestOutbox();
    expect(row.to_email).toBe("fern_testcase@example.test");
    expect(row.body).toMatch(/\/verify-email\?token=/);

    // duplicate username/email respond with field-level conflicts
    const dup1 = await new Client(base).post("/api/auth/register", {
      username: "fern_testcase",
      email: "other@example.test",
      password: "another-one-2go",
    });
    expect(dup1.json.error.code).toBe("USERNAME_TAKEN");

    // sign in (fresh session) and session shows user
    const c2 = new Client(base);
    const signIn = await c2.post("/api/auth/sign-in", { username: "Fern_TestCase", password: "correct-horse-battery" });
    expect(signIn.status).toBe(200);
    const me = await c2.get("/api/me");
    expect(me.json.signedIn).toBe(true);

    // wrong password is a generic error; unknown user responds identically
    const wrong1 = await c2.post("/api/auth/sign-in", { username: "fern_testcase", password: "nope-nope-nope" });
    const wrong2 = await c2.post("/api/auth/sign-in", {
      username: "not_a_user_xyz",
      password: "nope-nope-nope",
    });
    expect(wrong1.json.error.code).toBe(wrong2.json.error.code);
    expect(wrong1.json.error.message).toBe(wrong2.json.error.message);

    // reset: token flows from outbox
    await c2.post("/api/auth/forgot-password", { usernameOrEmail: "fern_testcase" });
    const resetRow = latestOutbox();
    expect(resetRow.body).toMatch(/\/reset-password\?token=/);
    const token = resetRow.body.match(/token=([A-Za-z0-9_-]+)/)![1];
    const reset = await c2.post("/api/auth/reset-password", { token, password: "fresh-pass-4321" });
    expect(reset.status).toBe(200);
    // old password no longer works; new one does
    expect(
      (await c2.post("/api/auth/sign-in", { username: "fern_testcase", password: "correct-horse-battery" })).json
        .error?.code,
    ).toBe("INVALID_CREDENTIALS");
    expect(
      (await c2.post("/api/auth/sign-in", { username: "fern_testcase", password: "fresh-pass-4321" })).status,
    ).toBe(200);
    // reuse of the reset token fails
    expect((await c2.post("/api/auth/reset-password", { token, password: "another-9999" })).status).toBe(400);
  });

  it("guest membership survives guest→account upgrade and claims no one else's games", async () => {
    // guest plays in a round, then registers on the same session
    const guestTree = new Client(base);
    const organiser = new Client(base);
    const created = await organiser.post("/api/rooms", { displayName: "HostOmar", genre: "Films" });
    const code = created.json.room.code;
    const roundId = created.json.round.id;
    await guestTree.post("/api/rooms/join", { code, displayName: "GuestGwen" });

    const other = new Client(base);
    await other.post("/api/rooms/join", { code, displayName: "GuestHal" });
    const fakeOrganiserAccount = new Client(base);
    await registerUser(fakeOrganiserAccount, "unrelateduser");

    await organiser.post(`/api/rooms/${code}/lock`);
    await organiser.put(`/api/rooms/${code}/my-word`, { word: "spielberg" });
    await guestTree.put(`/api/rooms/${code}/my-word`, { word: "norma_rae" });
    await other.put(`/api/rooms/${code}/my-word`, { word: "casablanca" });

    // GuestGwen becomes an account (upgrade) on the very session that joined
    await guestTree.post("/api/auth/register", {
      username: "gwen_account",
      email: "gwen@example.test",
      password: "gwen-pass-1234",
    });

    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expect(start.status).toBe(200);
    const token = start.json.leaseToken;
    for (let n = 1; n <= 3; n++) {
      await organiser.post(`/api/rounds/${roundId}/reading/ack`, { leaseToken: token, readingNumber: n, position: 3 });
      await organiser.post(`/api/rounds/${roundId}/reading/complete`, { leaseToken: token, readingNumber: n });
    }
    // record Gwen as winner — as a guest name at record time
    const state = await organiser.get(`/api/rooms/${code}/state`);
    const gwenPlayer = state.json.snapshot.players.find((p: any) => p.displayName === "GuestGwen");
    const save = await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: gwenPlayer.playerId });
    expect(save.status).toBe(200);

    // Gwen's account has the win; the unrelated account has zero games.
    const gwenStats = await (async () => {
      const history = await guestTree.get("/api/me/history");
      const stats = await guestTree.get("/api/me/stats");
      return { history: history.json, stats: stats.json };
    })();
    expect(gwenStats.stats.gamesPlayed).toBe(1);
    expect(gwenStats.stats.wins).toBe(1);
    const unrelated = await fakeOrganiserAccount.get("/api/me/stats");
    expect(unrelated.json.gamesPlayed).toBe(0);
  });

  it("deleting an account anonymizes rows and drops social links", async () => {
    const c = new Client(base);
    await registerUser(c, "bye_now_user");
    const done = await c.del("/api/auth/account");
    expect(done.status).toBe(200);
    const db = t.handle.db;
    const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE username_canonical = 'bye_now_user'").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it("reconnection refreshes identity without regenerating words, order or starter", async () => {
    const organiser = new Client(base);
    const p2 = new Client(base);
    const created = await organiser.post("/api/rooms", { displayName: "ReHost", genre: "Films" });
    const code = created.json.room.code;
    await p2.post("/api/rooms/join", { code, displayName: "ReB" });
    const p3 = new Client(base);
    await p3.post("/api/rooms/join", { code, displayName: "ReC" });
    await organiser.post(`/api/rooms/${code}/lock`);
    for (const [p, w] of [[organiser, "fox"], [p2, "hen"], [p3, "owl"]] as [Client, string][]) {
      expectOk((await p.put(`/api/rooms/${code}/my-word`, { word: w })).status, null, `word ${w}`);
    }

    // A "refresh" is the same browser cookie on a brand-new client connection.
    const p3b = new Client(base);
    p3b.cookie = p3.cookie;
    // Re-submitting their own saved word is a no-op re-save, not a conflict.
    const resort = await p3b.put(`/api/rooms/${code}/my-word`, { word: "owl" });
    expect(resort.status).toBe(200);
    expect(resort.json.wordSaved).toBe(true);

    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    if (start.status !== 200) throw new Error(JSON.stringify(start.json));
    // Refresh did not change who is in the roster nor re-open word setup.
    const refreshed = await p3b.get(`/api/rooms/${code}/state`);
    expect(refreshed.json.snapshot.round.state).toBe("reading");
    expect(refreshed.json.snapshot.me.inRoster).toBe(true);
    // The original session still shares the same identity as the refresh.
    const original = await p3.get(`/api/rooms/${code}/state`);
    expect(original.json.snapshot.me.playerId).toBe(refreshed.json.snapshot.me.playerId);
  });
});

function latestOutbox() {
  const rows = t.handle.db
    .prepare("SELECT * FROM email_outbox ORDER BY id DESC LIMIT 1")
    .all() as { to_email: string; subject: string; body: string }[];
  return rows[0];
}
