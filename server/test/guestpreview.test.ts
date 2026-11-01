// Guest-preview mode: AUTH_ACCOUNTS_ENABLED must be set BEFORE app modules load
// (ESM imports hoist, so the harness is imported dynamically below).
process.env.AUTH_ACCOUNTS_ENABLED = "false";
process.env.ALLOW_DEV_EMAIL_PREVIEW = "";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "./harness.js";

let t: TestContext;
let base: string;
let ClientCtor: { new (baseUrl: string): { post: (...a: any[]) => Promise<any>; get: (...a: any[]) => Promise<any>; put: (...a: any[]) => Promise<any>; cookie: string } };

beforeAll(async () => {
  const harness = await import("./harness.js");
  ClientCtor = harness.Client;
  t = await harness.startTestServer();
  base = t.base;
});
afterAll(async () => {
  await t?.close();
});

const client = (): InstanceType<typeof ClientCtor> => new ClientCtor(base);


/* Guest-only preview: accounts are refused SERVER-side (not just hidden in the
 * UI) while guest play continues to work completely. */

describe("guest-preview mode", () => {
  it("declares the account capability (server truth, no secrets)", async () => {
    const caps = await client().get("/api/capabilities");
    expect(caps.json.accountsEnabled).toBe(false);
    expect(caps.json.accountsNotice).toContain("accounts are not available yet");
    expect(JSON.stringify(caps.json)).not.toMatch(/smtp|secret|session/i);
  });

  it("account endpoints are refused server-side with the preview message", async () => {
    const c = client();
    const expect403 = async (label: string, doReq: () => Promise<{ status: number; json: any }>) => {
      const r = await doReq();
      expect(r.status, label).toBe(403);
      expect(String(r.json?.error?.message), label).toContain("accounts are not available");
    };
    await expect403("register", () =>
      c.post("/api/auth/register", { username: "some_user", email: "u@e.test", password: "long-enough-pass-1" }),
    );
    await expect403("sign-in", () => c.post("/api/auth/sign-in", { username: "some_user", password: "x" }));
    await expect403("forgot", () => c.post("/api/auth/forgot-password", { usernameOrEmail: "someone" }));
    await expect403("friends", () => c.get("/api/friends"));
    await expect403("friend search", () => c.post("/api/friends/search", { username: "some_user" }));
    await expect403("friend request", () => c.post("/api/friends/requests", { username: "some_user" }));
    await expect403("invites list", () => c.get("/api/invites"));
    // an outstanding token can't be redeemed in preview mode either
    await expect403("verify", () => c.post("/api/auth/verify", { token: "whatever" }));
  });

  it("existing data stays intact: /api/me keeps working but reveals nothing", async () => {
    const c = client();
    const me = await c.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.json.signedIn).toBe(false);
  });

  it("guest play is fully available end-to-end (create → lock → words → readings → result → next round)", async () => {
    const organiser: ReturnType<typeof client> = client();
    const created = await organiser.post("/api/rooms", { displayName: "GuestHost", genre: "Games" });
    expect(created.status).toBe(200);
    const code = created.json.room.code;
    const others = [client(), client()];
    for (const [i, p] of others.entries()) {
      expect((await p.post("/api/rooms/join", { code, displayName: `Preview${i}` })).status).toBe(200);
    }
    expect((await organiser.post(`/api/rooms/${code}/lock`)).status).toBe(200);
    const words = ["lama", "meerkat", "narwhal"];
    for (const [i, p] of [organiser, ...others].entries()) {
      expect((await p.put(`/api/rooms/${code}/my-word`, { word: words[i] })).status).toBe(200);
    }
    const start = await organiser.post(`/api/rooms/${code}/reading/start`);
    expect(start.status).toBe(200);
    const roundId = (await organiser.get(`/api/rooms/${code}/state`)).json.snapshot.round.id;
    for (let n = 1; n <= 3; n++) {
      expect(
        (
          await organiser.post(`/api/rounds/${roundId}/reading/ack`, {
            leaseToken: start.json.leaseToken,
            readingNumber: n,
            position: 3,
          })
        ).status,
      ).toBe(200);
      const done = await organiser.post(`/api/rounds/${roundId}/reading/complete`, {
        leaseToken: start.json.leaseToken,
        readingNumber: n,
      });
      expect(done.status).toBe(200);
    }
    const winner = (await organiser.get(`/api/rooms/${code}/state`)).json.snapshot.players[1];
    expect((await organiser.post(`/api/rounds/${roundId}/result`, { winnerPlayerId: winner.playerId })).status).toBe(200);
    // guest identity still gets stats/history (session-based, not account-based)
    const guestStats = await others[0].get("/api/me/stats");
    expect(guestStats.json.gamesPlayed).toBe(1);
    // privacy: no word of others anywhere in the snapshot
    const st = (await others[0].get(`/api/rooms/${code}/state`)).json;
    expect(JSON.stringify(st)).not.toContain("larma");
    expect(JSON.stringify(st)).not.toContain("meerkat");
    // next round stays available to the same guests
    expect((await organiser.post(`/api/rounds/${roundId}/next-round`)).status).toBe(200);
  });
});
