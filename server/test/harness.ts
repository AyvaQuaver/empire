import { createApp, type AppHandle } from "../src/app.js";

export interface TestContext {
  handle: AppHandle;
  base: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestContext> {
  const handle = createApp({ dbFile: ":memory:", port: 0 });
  const port = await handle.listen();
  return {
    handle,
    base: `http://127.0.0.1:${port}`,
    close: () => handle.close(),
  };
}

/** A cookie-managed test client standing in for one browser session. */
export interface ClientResponse {
  status: number;
  json: any;
  cookie: string;
  headers: { cacheControl: string | null; xRobotsTag: string | null; setCookieCount: number };
}

export class Client {
  cookie = "";
  constructor(readonly base: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    includeCookie = true,
  ): Promise<ClientResponse> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-empire-with": "fetch",
        ...(this.cookie && includeCookie ? { cookie: this.cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    // A browser applies multiple Set-Cookie headers in order: the LAST one wins.
    // (E.g. session middleware issues a guest cookie, then sign-in replaces it.)
    const setCookieList = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (setCookieList.length) {
      const m = setCookieList.map((v) => v.match(/empire_sid=([^;]+)/)).filter(Boolean);
      const last = m[m.length - 1];
      if (last) this.cookie = `empire_sid=${last[1]}`;
    } else {
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const m = setCookie.match(/empire_sid=([^;]+)/);
        if (m) this.cookie = `empire_sid=${m[1]}`;
      }
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return {
      status: res.status,
      json,
      cookie: this.cookie.slice(0, 20) + "…",
      headers: {
        cacheControl: res.headers.get("cache-control"),
        xRobotsTag: res.headers.get("x-robots-tag"),
        setCookieCount: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie().length : 0,
      },
    };
  }

  get(path: string, extra?: Record<string, string>): Promise<ClientResponse> {
    return this.request("GET", path, undefined, extra) as any;
  }
  post(path: string, body?: unknown, extra?: Record<string, string>): Promise<ClientResponse> {
    return this.request("POST", path, body, extra) as any;
  }
  put(path: string, body?: unknown): Promise<ClientResponse> {
    return this.request("PUT", path, body) as any;
  }
  patch(path: string, body?: unknown): Promise<ClientResponse> {
    return this.request("PATCH", path, body) as any;
  }
  del(path: string, body?: unknown): Promise<ClientResponse> {
    return this.request("DELETE", path, body) as any;
  }
}

export async function createRoomBy(c: Client, displayName: string, genre = "Animals") {
  const res = await c.post("/api/rooms", { displayName, genre });
  if (res.status !== 200) throw new Error(`createRoom failed: ${JSON.stringify(res.json)}`);
  return res.json as { room: { code: string }; invitationUrl: string; round: { id: string } };
}

export async function joinByCode(c: Client, code: string, displayName: string) {
  return c.post("/api/rooms/join", { code, displayName }) as Promise<
    { status: number; json: { room?: { code: string }; reconnected?: boolean }; cookie: string; headers: Record<string, unknown> }
  >;
}

export const expectOk = (status: number, json: any, label = "") => {
  if (status >= 400) throw new Error(`${label} expected ok, got ${status}: ${JSON.stringify(json)}`);
};
