import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, Client, expectOk, type TestContext } from "./harness.js";

let t: TestContext;
let base: string;

beforeAll(async () => {
  t = await startTestServer();
  base = t.base;
  // Importing api.ts pulls clearRateLimits bound to the same store the suite uses.
  const mod = await import("../src/api.js");
  mod.clearRateLimits();
});
afterAll(async () => {
  await t.close();
});

/* Join-link surface (server contract): previews resolve safely, identity
 * reconstruction is idempotent, and normal room validation applies. */

describe("invitation preview & joining contract", () => {
  it("preview exposes only title/genre/status — no players, no codes", async () => {
    const organiser = new Client(base);
    const created = await organiser.post("/api/rooms", { displayName: "LinkHost", genre: "Films" });
    const url = new URL(created.json.invitationUrl as string);
    const token = url.pathname.split("/join/")[1] ?? url.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(10);
    const preview = await new Client(base).get(`/api/join/preview?token=${encodeURIComponent(token)}`);
    expect(preview.json.title).toBe("LinkHost's game");
    expect(JSON.stringify(preview.json)).not.toContain("LinkHost\" ,\"player");
    expect(preview.json).not.toHaveProperty("players");
    expect(preview.json).not.toHaveProperty("code");
    for (const [i, p] of [new Client(base), new Client(base)].entries()) {
      expectOk((await p.post("/api/rooms/join", { code: created.json.room.code, displayName: `Link${i}` })).status, null, "join");
    }
    // after lock the preview still works (status flips) but joining is refused
    expectOk((await organiser.post(`/api/rooms/${created.json.room.code}/lock`)).status, null, "lock");
    const late = new Client(base);
    const lateJoin = await lateJoinByToken(late, token, "LinkLate");
    expect(lateJoin.status).toBe(409);
  });

  it("joining by token twice is an idempotent rejoin (same identity, no duplicate membership)", async () => {
    const organiser = new Client(base);
    const created = await organiser.post("/api/rooms", { displayName: "IdemHost", genre: "Games" });
    const url = new URL(created.json.invitationUrl as string);
    const token = url.pathname.split("/join/")[1];
    const c = new Client(base);
    const first = await c.post("/api/rooms/join", { invitationToken: token, displayName: "Idem" });
    expect(first.status).toBe(200);
    expect(first.json.reconnected).toBe(false);
    const second = await c.post("/api/rooms/join", { invitationToken: token, displayName: "Idem" });
    expect(second.status).toBe(200);
    expect(second.json.reconnected).toBe(true); // same device, same membership
    const st = await c.get(`/api/rooms/${created.json.room.code}/state`);
    // exactly one membership for this session
    expect(st.json.snapshot.players.filter((p: any) => p.isMe).length).toBe(1);
  });

  it("a forged/invalid token never joins or leaks", async () => {
    const forged = await new Client(base).post("/api/rooms/join", {
      invitationToken: "not-a-real-token-aaaaaaaa",
      displayName: "Sneak",
    });
    expect(forged.status).toBe(404);
    expect(JSON.stringify(forged.json)).not.toContain("displayName");
    // an unknown token's preview is refused without leaking anything
    const preview = await new Client(base).get("/api/join/preview?token=not-a-real-token-aaaaaaaa");
    expect(preview.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(preview.json)).not.toContain("LinkHost");
  });

  it("capacity is enforced through the link route too", async () => {
    const mod = await import("../src/api.js");
    mod.clearRateLimits();
    const organiser = new Client(base);
    const created = await organiser.post("/api/rooms", { displayName: "FullHost", genre: "Films" });
    const url = new URL(created.json.invitationUrl as string);
    const token = url.pathname.split("/join/")[1];
    void new Client(base);
    // capacity: 20 players total per room (organiser + 19). Clear the IP rate
    // limiter every few joins so the cap (not the limiter) is what's tested.
    for (let i = 0; i < 19; i++) {
      if (i > 0 && i % 5 === 0) mod.clearRateLimits();
      const r = await new Client(base).post("/api/rooms/join", { invitationToken: token, displayName: `Cap${i}` });
      expect(r.status, `join ${i}`).toBe(200);
    }
    const overCapProbe = await new Client(base).post("/api/rooms/join", { invitationToken: token, displayName: "CapOver" });
    expect(overCapProbe.status).toBe(409);
    expect(overCapProbe.json.error.code).toBe("ROOM_FULL");
  });
});

async function lateJoinByToken(c: Client, token: string, displayName: string) {
  return c.post("/api/rooms/join", { invitationToken: token, displayName });
}
