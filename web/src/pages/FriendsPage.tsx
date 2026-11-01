import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Avatar, Button, ErrorBanner, Input, Panel } from "../components/ui";
import { Page, useSession } from "../App";

interface Friend {
  userId: string;
  username: string;
}

interface RequestRow {
  id: number;
  direction: "incoming" | "outgoing";
  username: string;
}

interface InviteRow {
  id: number;
  room_code: string;
  title: string;
  from_name: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}

const avatarTones = ["avatar-lav", "avatar-coral", "avatar-panel"];

/* Friends: exact-username search (no emails), accept/decline/cancel/remove,
 * plus in-app game invitations visible only to their recipient. */
export default function FriendsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [searchResult, setSearchResult] = useState<{ found: boolean; username?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!session.signedIn) return;
    try {
      const [f, r, i] = await Promise.all([
        api.get<{ friends: Friend[] }>("/api/friends"),
        api.get<{ requests: RequestRow[] }>("/api/friends/requests"),
        api.get<{ invites: InviteRow[] }>("/api/invites"),
      ]);
      setFriends(f.friends);
      setRequests(r.requests);
      setInvites(i.invites);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load friends.");
    }
  };

  useEffect(() => {
    if (!session.loading && session.signedIn) void refresh();
  }, [session.loading, session.signedIn]);

  if (!session.loading && !session.signedIn) {
    return (
      <Page>
        <h1 style={{ fontSize: 28 }}>Friends</h1>
        <p>
          Friends are an account feature. You can still play as a guest any time.
        </p>
        <Button className="btn-primary btn-cta" onClick={() => navigate("/sign-in")}>
          Sign in
        </Button>
        <Button className="btn-ghost" onClick={() => navigate("/")}>
          Back home
        </Button>
      </Page>
    );
  }

  const doSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSearchResult(null);
    try {
      const out = await api.post<{ found: boolean; username?: string }>("/api/friends/search", { username: search });
      setSearchResult(out);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed.");
    }
    setBusy(false);
  };

  const sendRequest = async () => {
    setBusy(true);
    try {
      await api.post("/api/friends/requests", { username: search });
      setSearch("");
      setSearchResult(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send request.");
    }
    setBusy(false);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
    }
    setBusy(false);
  };

  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>Friends</h1>
      <ErrorBanner error={error} />

      <Panel heading="Find a friend">
        <form onSubmit={doSearch}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="exact username"
            aria-label="Exact username to search"
            maxLength={24}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button type="submit" className="btn-small btn-secondary" loading={busy}>
              Search
            </Button>
            {searchResult?.found && (
              <Button type="button" className="btn-small btn-primary" onClick={sendRequest}>
                Add {searchResult.username}
              </Button>
            )}
          </div>
          {searchResult && !searchResult.found && (
            <p className="status-text" role="status">
              No player found with that exact username.
            </p>
          )}
        </form>
      </Panel>

      {requests && requests.length > 0 && (
        <Panel heading="Requests">
          {requests.map((r) => (
            <div className="player-row" key={`${r.direction}-${r.id}`}>
              <Avatar name={r.username} playerId={String(r.id)} />
              <span className="player-name">
                {r.username} {r.direction === "incoming" ? "wants to be friends" : "· waiting for reply"}
              </span>
              {r.direction === "incoming" && (
                <>
                  <Button className="btn-small btn-primary" onClick={() => void act(() => apiRespond(r.id, true))}>
                    Accept
                  </Button>
                  <Button className="btn-small btn-ghost" onClick={() => void act(() => apiRespond(r.id, false))}>
                    Decline
                  </Button>
                </>
              )}
              {r.direction === "outgoing" && (
                <Button className="btn-small btn-ghost" onClick={() => void act(() => apiCancel(r.id))}>
                  Cancel
                </Button>
              )}
            </div>
          ))}
        </Panel>
      )}

      <Panel heading="Your friends">
        {friends === null ? (
          <p className="skeleton" role="status">
            Loading…
          </p>
        ) : friends.length === 0 ? (
          <p className="status-text">No friends yet. Search an exact username above.</p>
        ) : (
          friends.map((f) => (
            <div className="player-row" key={f.userId}>
              <Avatar name={f.username} playerId={f.userId} />
              <span className="player-name">{f.username}</span>
              <Button className="btn-small btn-ghost" onClick={() => void act(() => apiRemoveFriend(f.userId))}>
                Remove
              </Button>
            </div>
          ))
        )}
      </Panel>

      <Panel heading="Game invitations">
        {invites === null ? (
          <p className="skeleton" role="status">
            Loading…
          </p>
        ) : invites.length === 0 ? (
          <p className="status-text">No invitations. Friends can invite you from an open game lobby.</p>
        ) : (
          invites.map((i) => (
            <div className="player-row" key={i.id}>
              <span className="player-name">
                <strong>{i.from_name}</strong> · {i.title}
                {i.accepted_at ? " (used)" : ""}
              </span>
              <Button
                className="btn-small btn-primary"
                disabled={!!i.accepted_at}
                onClick={() =>
                  void act(async () => {
                    const out = await api.post<{ roomCode: string }>(`/api/invites/${i.id}/accept`);
                    if (out.roomCode) navigate(`/room/${out.roomCode}`);
                  })
                }
              >
                {i.accepted_at ? "Open" : "Join game"}
              </Button>
            </div>
          ))
        )}
        <p className="status-text">Invitations live inside Empire only — no emails or push notifications are sent.</p>
      </Panel>
      <Button className="btn-ghost" onClick={() => navigate("/profile")}>
        Back to profile
      </Button>
    </Page>
  );
}

const apiRespond = (id: number, accept: boolean) => api.post(`/api/friends/requests/${id}/respond`, { accept });
const apiCancel = (id: number) => api.post(`/api/friends/requests/${id}/cancel`);
const apiRemoveFriend = (userId: string) => api.del(`/api/friends/${userId}`);
void avatarTones;
