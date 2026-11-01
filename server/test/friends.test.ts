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

const account = async (name: string): Promise<Client> => {
  const c = new Client(base);
  await c.post("/api/auth/register", {
    username: name,
    email: `${name.toLowerCase()}@example.test`,
    password: "long-enough-pass",
  });
  return c;
};

void account;

describe("friendships", () => {
  it("exact search, send/accept, crossed requests collapse into friendship", async () => {
    const alice = await account("Alice_F");
    const bob = await account("Bob_F");
    const cara = await account("Cara_F");

    // search: exact only, no email exposure
    const found = await alice.post("/api/friends/search", { username: "Bob_F" });
    expect(found.json.found).toBe(true);
    expect(JSON.stringify(found.json)).not.toContain("@");
    const notFound = await alice.post("/api/friends/search", { username: "Bob" });
    expect(notFound.json.found).toBe(false);

    // alice → bob
    expect((await alice.post("/api/friends/requests", { username: "Bob_F" })).status).toBe(200);
    // duplicate request rejected
    expect((await alice.post("/api/friends/requests", { username: "Bob_F" })).status).toBe(409);
    // self request: exact search treats the searcher's own name as not found
    expect((await alice.post("/api/friends/requests", { username: "Alice_F" })).status).toBe(404);

    // crossed request from the real Bob collapses straight into a friendship
    expect((await bob.post("/api/friends/requests", { username: "Alice_F" })).status).toBe(200);
    const aliceFriends = await alice.get("/api/friends");
    expect(aliceFriends.json.friends.map((f: any) => f.username)).toEqual(["Bob_F"]);
    // no leftover pending pair: nothing for alice to accept any more
    const aliceReqs = await alice.get("/api/friends/requests");
    expect(aliceReqs.json.requests.filter((r: any) => r.direction === "incoming")).toHaveLength(0);

    // can't re-request an existing friendship
    expect((await alice.post("/api/friends/requests", { username: "Bob_F" })).status).toBe(409);

    // unrelated pair still can request normally after the collapse
    expect((await cara.post("/api/friends/requests", { username: "Bob_F" })).status).toBe(200);
  });

  it("decline, cancel, remove, and permission boundaries", async () => {
    const dan = await account("Dan_G");
    const elle = await account("Elle_G");
    await dan.post("/api/friends/requests", { username: "Elle_G" });
    // Dan can't respond to his own outgoing request
    const danReqs = await dan.get("/api/friends/requests");
    const outgoing = danReqs.json.requests.filter((r: any) => r.direction === "outgoing")[0];
    expect((await dan.post(`/api/friends/requests/${outgoing.id}/respond`, { accept: true })).status).toBe(404);
    // cancel works
    expect((await dan.post(`/api/friends/requests/${outgoing.id}/cancel`)).status).toBe(200);
    // new request, Elle declines
    await dan.post("/api/friends/requests", { username: "Elle_G" });
    const elleReqs = await elle.get("/api/friends/requests");
    const incoming = elleReqs.json.requests.filter((r: any) => r.direction === "incoming")[0];
    expect((await elle.post(`/api/friends/requests/${incoming.id}/respond`, { accept: false })).status).toBe(200);
    const elleFriends = await elle.get("/api/friends");
    expect(elleFriends.json.friends.length).toBe(0);

    // now real friendship → removal
    await dan.post("/api/friends/requests", { username: "Elle_G" });
    const elleReqs2 = await elle.get("/api/friends/requests");
    const inc2 = elleReqs2.json.requests.filter((r: any) => r.direction === "incoming")[0];
    await elle.post(`/api/friends/requests/${inc2.id}/respond`, { accept: true });
    const userId = (await dan.get("/api/friends")).json.friends[0].userId; // Elle's user id, seen from Dan
    expect((await dan.del(`/api/friends/${userId}`)).status).toBe(200);
    expect((await dan.get("/api/friends")).json.friends.length).toBe(0);
  });

  it("room invitations only reach accepted friends and honour room lock", async () => {
    const frank = await account("Frank_H");
    const greta = await account("Greta_H");
    const henry = await account("Henry_H");
    void henry;

    // make frank & greta friends
    await frank.post("/api/friends/requests", { username: "Greta_H" });
    const reqs = await greta.get("/api/friends/requests");
    await greta.post(`/api/friends/requests/${reqs.json.requests[0].id}/respond`, { accept: true });

    const room = await frank.post("/api/rooms", { displayName: "Frank", genre: "Sports" });
    const code = room.json.room.code;

    // invite a non-friend fails
    const bad = await frank.post(`/api/rooms/${code}/invites`, { userId: (await find(frank, "Henry_H")) });
    expect(bad.status).toBe(403);
    // invite a friend succeeds; recipient-scoped
    const ok = await frank.post(`/api/rooms/${code}/invites`, { userId: await find(frank, "Greta_H") });
    expect(ok.status).toBe(200);
    const gretaInvites = await greta.get("/api/invites");
    expect(gretaInvites.json.invites.length).toBe(1);
    const other = await (await c2("Henry_H")).get("/api/invites");
    expect(other.json.invites.length).toBe(0);

    // after locking, new invites are refused (roster is locked)
    const p2 = new Client(base);
    const p3 = new Client(base);
    await p2.post("/api/rooms/join", { code, displayName: "Sprout" });
    await p3.post("/api/rooms/join", { code, displayName: "Sage" });
    void p2;
    void p3;
    const locked = await frank.post(`/api/rooms/${code}/lock`);
    expect(locked.status).toBe(200);
    const late = await frank.post(`/api/rooms/${code}/invites`, { userId: await find(frank, "Henry_H") });
    expect(late.status).toBe(409);
  });
});

async function find(c: Client, username: string): Promise<string> {
  const res = await c.post("/api/friends/search", { username });
  return res.json.userId as string;
}

async function c2(username: string): Promise<Client> {
  // A freshly signed-in client for the given username
  const c = new Client(base);
  const r = await c.post("/api/auth/sign-in", { username, password: "long-enough-pass" });
  expect(r.status).toBe(200);
  return c;
}
