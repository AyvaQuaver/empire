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

/* Auth & infrastructure guards: token expiry/one-time use, session revocation
 * (sign-out, password reset), guest history-claim refusal, dev-outbox isolation,
 * cleanup endpoint authentication, and Cache-Control on private responses. */

const registerUser = async (username: string, password = "long-enough-pass-1"): Promise<Client> => {
  const c = new Client(base);
  const res = await c.post("/api/auth/register", {
    username,
    email: `${username.toLowerCase()}@example.test`,
    password,
  });
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.json)}`);
  return c;
};

describe("session & token guards", () => {
  it("sign-out revokes the session; the old cookie is dead", async () => {
    const c = await registerUser("Revoke_One");
    expect((await c.get("/api/me")).json.signedIn).toBe(true);
    expect((await c.post("/api/auth/sign-out")).status).toBe(200);
    // signed-out identity: /api/me shows no user AND member endpoints refuse
    const after = await c.get("/api/me");
    expect(after.json.signedIn).toBe(false);
    expect(after.json.user).toBeNull();
    const friends = await c.get("/api/friends");
    expect(friends.status).toBe(401); // requireUser can't resolve a dead session
  });

  it("password reset revokes every existing session for the account", async () => {
    const c = await registerUser("Reset_Sessions");
    await c.post("/api/auth/forgot-password", { usernameOrEmail: "reset_sessions" });
    const token = latestOutboxBody(/^\|reset-password|reset-password/)?.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
    expect(token).toBeTruthy();
    expect((await c.post("/api/auth/reset-password", { token, password: "a-fresh-pass-77" })).status).toBe(200);
    // the still-logged-in session was dropped as part of the reset
    expect((await c.get("/api/me")).json.signedIn).toBe(false);
    // and the OLD password can't sign in; the new one works
    expect(
      (await c.post("/api/auth/sign-in", { username: "reset_sessions", password: "long-enough-pass-1" })).status,
    ).toBe(401);
    expect((await c.post("/api/auth/sign-in", { username: "reset_sessions", password: "a-fresh-pass-77" })).status)
      .toBe(200);
  });

  it("reset tokens are single-use and expire", async () => {
    const c = await registerUser("Token_TTL");
    await c.post("/api/auth/forgot-password", { usernameOrEmail: "token_ttl" });
    const token = latestOutboxBody(/reset-password/)?.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
    expect((await c.post("/api/auth/reset-password", { token, password: "reuse-test-pass-1" })).status).toBe(200);
    // reuse of the SAME token fails
    expect((await c.post("/api/auth/reset-password", { token, password: "reuse-test-pass-2" })).status).toBe(400);
    // an artificially expired token fails even before use
    await c.post("/api/auth/forgot-password", { usernameOrEmail: "token_ttl" });
    const token2 = latestOutboxBody(/reset-password/)?.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
    t.handle.db
      .prepare("UPDATE email_tokens SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM email_tokens WHERE used_at IS NULL ORDER BY id DESC LIMIT 1)")
      .run(Date.now() - 1000);
    expect((await c.post("/api/auth/reset-password", { token: token2, password: "too-late-pass-99" })).status).toBe(
      400,
    );
  });

  it("cleanup endpoint is authenticated: no token → 404; right token → runs", async () => {
    // Without CLEANUP_TOKEN the endpoint looks like a normal 404.
    expect((await new Client(base).post("/api/internal/cleanup")).status).toBe(404);
    expect((await new Client(base).post("/api/internal/cleanup", {})).status).toBe(404);
    process.env.CLEANUP_TOKEN = "guard-test-token";
    const withToken = new Client(base);
    const ok = await withToken.post("/api/internal/cleanup", {}, { "x-cleanup-token": "guard-test-token" });
    expect(ok.status).toBe(200);
    const badToken = new Client(base);
    expect((await badToken.post("/api/internal/cleanup", {}, { "x-cleanup-token": "nope" })).status).toBe(404);
    delete process.env.CLEANUP_TOKEN;
  });

  it("private responses are not cacheable (no-store)", async () => {
    const c = await registerUser("Cache_Header");
    const me = await c.get("/api/me");
    expect(me.json.signedIn).toBe(true);
    expect(me.headers.cacheControl).toBe("no-store");
    expect(me.headers.xRobotsTag).toBe("noindex");
    const state = await c.get("/api/rooms/NOPE99/state");
    expect(state.json.error.code).toBe("NOT_FOUND");
    expect(state.headers.cacheControl).toBe("no-store");
    const health = await c.get("/api/health");
    expect(health.headers.cacheControl).toBe("no-store");
  });

  it("a roster member can explicitly take over an active lease; the old device is fenced out", async () => {
    const organiser = new Client(base);
    const created = await organiser.post("/api/rooms", { displayName: "TakeHost", genre: "Films" });
    const code = created.json.room.code;
    const roundId = created.json.round.id;
    const p2 = new Client(base);
    const p3 = new Client(base);
    expect((await p2.post("/api/rooms/join", { code, displayName: "Sloane0" })).status).toBe(200);
    expect((await p3.post("/api/rooms/join", { code, displayName: "Sloane1" })).status).toBe(200);
    expect((await organiser.post(`/api/rooms/${code}/lock`)).status).toBe(200);
    for (const [p, w] of [[organiser, "drama"], [p2, "mesh"], [p3, "ode"]] as [Client, string][]) {
      expect((await p.put(`/api/rooms/${code}/my-word`, { word: w })).status).toBe(200);
    }
    // organiser holds the speaker lease via start
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expect(start.status).toBe(200);
    const organiserToken = start.json.leaseToken as string;
    // p2 (not organiser) takes over with the explicit force flag
    const takeover = await p2.post(`/api/rounds/${roundId}/lease`, { action: "takeover", force: true });
    expect(takeover.status).toBe(200);
    const p2Token = takeover.json.leaseToken as string;
    expect(p2Token).toBeTruthy();
    // the previous device is now fenced out: its token is stale
    expect(
      (
        await organiser.post(`/api/rounds/${roundId}/reading/ack`, {
          leaseToken: organiserToken,
          readingNumber: 1,
          position: 1,
        })
      ).status,
    ).toBe(403);
    // but the takeover holder can use theirs (right session + right token)
    expect(
      (
        await p2.post(`/api/rounds/${roundId}/reading/ack`, {
          leaseToken: p2Token,
          readingNumber: 1,
          position: 1,
        })
      ).status,
    ).toBe(200);
    // the payload's word list carries no names and no ownership metadata
    const payload = await p2.get(`/api/rounds/${roundId}/reading/words?reading=1`, { "x-empire-lease": p2Token });
    expect(payload.status).toBe(200);
    const body = JSON.stringify(payload.json);
    expect(new Set(payload.json.words as string[])).toEqual(new Set(["drama", "mesh", "ode"]));
    expect(body).not.toContain("Sloane");
    expect(payload.json).not.toHaveProperty("owner");
    expect(payload.json).not.toHaveProperty("playerId");
    expect(Object.keys(payload.json as object).filter((k) => k !== "readingNumber" && k !== "words")).toEqual([]);
  });
});

function latestOutboxBody(_match?: RegExp): string | undefined {
  const rows = t.handle.db
    .prepare("SELECT body FROM email_outbox ORDER BY id DESC LIMIT 1")
    .all() as { body: string }[];
  return rows[0]?.body;
}
