export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-empire-with": "fetch", // simple CSRF companion to SameSite=Lax cookies
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("NETWORK", 0, "You're offline. Check your connection and try again.");
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error ?? {};
    throw new ApiError(err.code ?? "INTERNAL", res.status, err.message ?? "Something went wrong. Try again.", err.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, extra?: Record<string, string>) => request<T>("GET", path, undefined, extra),
  post: <T>(path: string, body?: unknown, extra?: Record<string, string>) => request<T>("POST", path, body ?? {}, extra),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body ?? {}),
};

// ---- session shape shared by pages ----
export interface MeResponse {
  signedIn: boolean;
  user: { id: string; username: string; emailVerified: boolean } | null;
}

export interface RoomSnapshotResponse {
  member: boolean;
  snapshot?: RoomSnapshot;
  room?: { code: string; title: string; genre: string; status: string };
}

export interface RoomSnapshot {
  me: { playerId: string; displayName: string; isOrganiser: boolean; inRoster: boolean };
  auth: { signedIn: boolean; username: string | null };
  room: { code: string; title: string; genre: string; state: string };
  round: { id: string; seq: number; state: string; minPlayers: number; maxPlayers: number };
  players: {
    playerId: string;
    displayName: string;
    isOrganiser: boolean;
    isMe: boolean;
    inRoster: boolean;
    ready: boolean | null;
  }[];
  rosterPreview: { confirmed: string[]; waiting: string[] } | null;
  readiness: { ready: number; total: number } | null;
  myWord: string | null;
  canSubmitWord: boolean;
  reading: {
    held: boolean;
    mine: boolean;
    readingNumber: number;
    position: number;
    transferPendingForMe: boolean;
    speaker: { playerId: string; displayName: string } | null;
  } | null;
  speakerActive: boolean;
  starter: { playerId: string; displayName: string } | null;
  result: {
    roundSeq: number;
    genre: string;
    winnerName: string;
    winnerPlayerId: string;
    recordedByName: string;
    recordedAt: number;
    correctionCount: number;
    participants: { playerId: string; name: string }[];
    isOrganiser: boolean;
  } | null;
  invitationUrl: string;
}
