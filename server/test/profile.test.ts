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

/* Account profile: editable display name (decoupled from the sign-in
 * username), sticky avatar colour, and lobby naming rules. */

async function account(displayName: string): Promise<{ client: Client; username: string }> {
  const c = new Client(base);
  await c.get("/api/capabilities");
  const username = `pr_${Math.random().toString(36).slice(2, 8)}`;
  expectOk(
    (
      await c.post("/api/auth/register", {
        username,
        email: `${username}@example.test`,
        password: "long-enough-pass-1",
      })
    ).status,
    null,
    "register",
  );
  void displayName;
  return { client: c, username };
}

async function signedInUser(c: Client) {
  const me = await c.get("/api/me");
  return me.json.user as { username: string; displayName: string; avatarColor: string };
}

function userRowByUsername(username: string): { display_name: string | null; avatar_color: string | null } {
  return t.handle.db.prepare("SELECT display_name, avatar_color FROM users WHERE username = ?").get(username) as {
    display_name: string | null;
    avatar_color: string | null;
  };
}

describe("display-name profile", () => {
  it("registers with a display name defaulted from the username (migration applied)", async () => {
    const { username } = await account("whatever");
    const me = await signedInUser((await (async () => {
      const c = new Client(base);
      expectOk((await c.post("/api/auth/sign-in", { username, password: "long-enough-pass-1" })).status, null, "signin");
      return c;
    })()));
    expect(me.displayName).toBe(username);
    expect(me.avatarColor).toMatch(/^(coral|grape|lavender|peach|ink|plum)$/);
    const row = userRowByUsername(username);
    expect(row.avatar_color).toBe(me.avatarColor); // persisted, not random per render
  });

  it("edits ONLY the authenticated user; validation enforced; username untouched", async () => {
    const mine = await account("x");
    const before = userRowByUsername(mine.username);
    expect((await mine.client.patch("/api/me/profile", { displayName: null as never })).status).toBe(400);
    expect((await mine.client.patch("/api/me/profile", { displayName: "   " })).status).toBe(400);
    expect((await mine.client.patch("/api/me/profile", { displayName: "!!!!" })).status).toBe(400);
    expect((await mine.client.patch("/api/me/profile", { displayName: "\u0007ding" })).status).toBe(400);
    const saved = await mine.client.patch("/api/me/profile", { displayName: "  Minette  Aliénor " });
    expect(saved.status).toBe(200);
    expect((saved.json as { displayName: string }).displayName).toBe("Minette Aliénor");
    const after = userRowByUsername(mine.username);
    // credentials stable; only the public name moved
    expect(after.display_name).toBe("Minette Aliénor");
    expect(after.avatar_color).toBe(before.avatar_color);
    const me = await signedInUser(mine.client);
    expect(me.username).toBe(mine.username); // sign-in identifier unchanged

    // another user cannot edit someone else's row (single account row targeted)
    const other = await account("y");
    const otherSaved = await other.client.patch("/api/me/profile", { displayName: "Azure" });
    expect(otherSaved.status).toBe(200);
    expect(userRowByUsername(mine.username).display_name).toBe("Minette Aliénor");
    expect((await signedInUser(mine.client)).displayName).toBe("Minette Aliénor");

    // signed out: cannot edit at all
    const anon = new Client(base);
    await anon.get("/api/capabilities");
    expect((await anon.patch("/api/me/profile", { displayName: "Chiseler" })).status).toBe(401);
  });
});

describe("signed-in lobby naming", () => {
  it("uses the SAVED display name for create/join and ignores client spoofing", async () => {
    const mine = await account("z");
    expectOk(
      (await mine.client.patch("/api/me/profile", { displayName: "Renée" })).status,
      null,
      "rename",
    );
    const created = await mine.client.post("/api/rooms", { displayName: "COORDINATED SPOOF NAME", genre: "Films" });
    const code = created.json.room.code;
    const snap = await mine.client.get(`/api/rooms/${code}/state`);
    expect(snap.json.snapshot.players.find((p: { isMe: boolean }) => p.isMe).displayName).toBe("Renée");

    // a guest joins; duplicate-name handling stays intact
    const mate = new Client(base);
    await mate.get("/api/capabilities");
    expectOk((await mate.post("/api/rooms/join", { code, displayName: "Robin" })).status, null, "guest join");
    // a DIFFERENT guest session trying the same canonical name is rejected
    const duplicate = new Client(base);
    expect((await duplicate.post("/api/rooms/join", { code, displayName: "Renée" })).status).toBe(409);

    // a signed-in friend whose ACCOUNT name collides can pass a room-scope
    // nickname: the stored display name is NOT overwritten
    const renamer = new Client(base);
    const username2 = `pr_${Math.random().toString(36).slice(2, 8)}`;
    expectOk(
      (
        await renamer.post("/api/auth/register", {
          username: username2,
          email: `${username2}@example.test`,
          password: "long-enough-pass-1",
        })
      ).status,
      null,
      "register friend",
    );
    expectOk((await renamer.post("/api/rooms/join", { code, displayName: "anything", lobbyNickname: "Renée ⭐" })).status, null, "join w/ nickname");
    const snapAfter = await renamer.get(`/api/rooms/${code}/state`);
    const self = snapAfter.json.snapshot.players.find((p: { isMe: boolean }) => p.isMe);
    expect(self.displayName).toBe("Renée ⭐");
    expect(userRowByUsername(username2).display_name).toBe(username2); // account untouched
    // starter guest still works as ever when accounts are enabled
    const guest = new Client(base);
    expectOk((await guest.post("/api/rooms/join", { code, displayName: "Late Guest" })).status, null, "late guest");
  });

  it("renaming does not disturb history binding or active-round identity", async () => {
    // sign in, rename mid-session, then check the /me identity + stats linkage
    const { client, username } = await account("k");
    await client.patch("/api/me/profile", { displayName: "History Bear" });
    const me = await signedInUser(client);
    expect(me.displayName).toBe("History Bear");
    expect(me.username).toBe(username);
    const stats = await client.get("/api/me/stats");
    expect(stats.status).toBe(200);
    expect(Object.keys(stats.json).length).toBeGreaterThan(0);
  });
});
