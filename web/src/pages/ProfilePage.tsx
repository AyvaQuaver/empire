import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Button, ErrorBanner, Field, Input, Panel } from "../components/ui";
import { Page, useSession } from "../App";
import { SignOutButton } from "./AuthPages";
import { avatarColors, initialOf } from "../components/AccountAvatar";

interface Stats {
  gamesPlayed: number;
  wins: number;
}

interface HistoryEntry {
  roundId: string;
  roomTitle: string;
  genre: string;
  finishedAt: number;
  winnerName: string;
  won: boolean;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Inline display-name editor: separate from the username/email credentials. */
function NameEditor({
  current,
  username,
  onSaved,
  onCancel,
}: {
  current: string;
  username: string | null;
  onSaved: (displayName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 380 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        api
          .patch<{ displayName: string }>("/api/me/profile", { displayName: value })
          .then((out) => onSaved(out.displayName))
          .catch((err) => {
            setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
            setBusy(false);
          });
      }}
    >
      <Field
        label="Display name"
        hint="This is the name other players see in lobbies. Sign-in username: keep it — you still use it to log in."
      >
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={24}
          autoComplete="nickname"
          required
          aria-label="Display name"
        />
      </Field>
      {username && (
        <p className="status-text" style={{ margin: 0 }}>
          You sign in with <strong>{username}</strong> and game invitations use your saved name.
        </p>
      )}
      <ErrorBanner error={error} />
      <div style={{ display: "flex", gap: 10 }}>
        <Button type="submit" className="btn-primary" loading={busy}>
          Save
        </Button>
        <Button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Profile: the account in the game's own visual language — coloured initial,
 * prominent wins, short recent history, friends and sign out. Deletion stays
 * visibly separate at the bottom. A genuine empty state until real results. */
export function ProfilePage() {
  const session = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [games, setGames] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.signedIn || session.loading) return;
    api
      .get<Stats>("/api/me/stats")
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load stats."));
    api
      .get<{ games: HistoryEntry[] }>("/api/me/history")
      .then((out) => setGames(out.games))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load history."));
  }, [session.signedIn, session.loading]);

  if (session.loading) {
    return (
      <Page>
        <p className="skeleton" role="status">
          Loading profile…
        </p>
      </Page>
    );
  }

  if (!session.signedIn) {
    return (
      <Page>
        <h1 style={{ fontSize: 28 }}>Your profile</h1>
        {session.accountsEnabled === false ? (
          <>
            <p className="status-text" role="status">
              Guest preview — accounts are not available yet. You can play as a guest.
            </p>
            <Link to="/" className="btn btn-primary">
              Play a game
            </Link>
          </>
        ) : (
          <>
            <p>Sign in to see your game history, stats and friends. Playing as a guest doesn't need an account.</p>
            <Link to="/sign-in" className="btn btn-primary">
              Sign in
            </Link>
            <Link to="/register" className="btn btn-secondary">
              Create an account
            </Link>
          </>
        )}
      </Page>
    );
  }

  const displayName = session.displayName ?? session.username ?? "";
  const { bg, fg } = avatarColors(session.avatarColor);
  const initial = initialOf(displayName);
  const wins = stats?.wins ?? null;

  return (
    <Page>
      {/* Identity block: larger coloured initial, name, edit affordance */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: "100%" }}>
        <span
          aria-hidden="true"
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: bg,
            color: fg,
            fontSize: 34,
            fontWeight: 800,
            fontFamily: "var(--font-display), system-ui, sans-serif",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            boxShadow: "0 3px 10px rgba(41, 20, 63, 0.22)",
          }}
        >
          {initial}
        </span>
        {!editing ? (
          <>
            <h1 style={{ fontSize: 30, margin: 0, overflowWrap: "anywhere", textAlign: "center" }}>{displayName}</h1>
            <button
              type="button"
              className="btn-ghost"
              aria-label="Edit display name"
              style={{
                minHeight: 44,
                padding: 4,
                textAlign: "center",
                fontWeight: 400,
                fontSize: 15,
              }}
              onClick={() => {
                setEditError(null);
                setEditing(true);
              }}
            >
              <span aria-hidden="true">✏️</span> Edit name
            </button>
          </>
        ) : (
          <NameEditor
            current={displayName}
            username={session.username}
            onSaved={(name) => {
              setEditing(false);
              void session
                .refresh()
                .then(() => {
                  setEditError(name ? null : null);
                })
                .catch(() => undefined);
              setEditError(null);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
        {editError && <ErrorBanner error={editError} />}
      </div>

      {/* Stats: wins get the crown treatment; games played is secondary. */}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
        <div
          className="panel"
          style={{
            width: "100%",
            maxWidth: 380,
            textAlign: "center",
            padding: "14px 12px 10px",
          }}
        >
          <p className="panel-heading" style={{ margin: 0 }}>
            Wins
          </p>
          <div
            aria-live="polite"
            style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 44, lineHeight: 1.1 }}
          >
            <span aria-hidden="true" style={{ fontSize: 28, verticalAlign: "4px", marginRight: 6 }}>
              👑
            </span>
            {wins ?? "…"}
          </div>
        </div>
        <p className="status-text" style={{ margin: "4px 0 0", textAlign: "center" }} role="status">
          {stats?.gamesPlayed === 0
            ? "Your first empire is waiting."
            : `Games played: ${stats?.gamesPlayed ?? "…"}`}
        </p>
      </div>

      <Panel heading="Recent games">
        {games === null ? (
          <p className="skeleton">Loading…</p>
        ) : games.length === 0 ? (
          <p className="status-text">
            No finished games yet. Wins show here once the organiser records a result — completed rounds only.
          </p>
        ) : (
          <ul className="manual-list" style={{ padding: 0 }}>
            {games.slice(0, 6).map((g) => (
              <li key={g.roundId} style={{ listStyle: "none" }}>
                <div className="player-row">
                  <span className="player-name">
                    {g.roomTitle} · {g.genre}
                    {g.won ? " 👑" : ""}
                  </span>
                  <span className="status-text" style={{ textAlign: "right" }}>
                    {formatDate(g.finishedAt)}
                    <br />
                    winner: {g.winnerName}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Link to="/friends" className="btn btn-secondary btn-cta">
        Friends &amp; requests
      </Link>
      {games && games.length === 0 && <ErrorBanner error={error} />}

      {/* Sign out is a normal account action; destructive settings stay separate */}
      <SignOutButton />
      <div
        className="panel-tight panel"
        style={{
          marginTop: 18,
          border: "1px dashed rgba(41, 20, 63, 0.25)",
          background: "rgba(255, 249, 237, 0.6)",
        }}
      >
        <p className="panel-heading" style={{ margin: 0 }}>
          Danger zone
        </p>
        <p className="status-text" style={{ margin: 0 }}>
          Deleting an account is permanent.
        </p>
        <Button className="btn-ghost" style={{ color: "#B23325" }} onClick={() => setDeleteOpen(true)}>
          Delete account
        </Button>
      </div>
      <ErrorBanner error={error} />

      {deleteOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Delete account">
          <div className="modal">
            <h2 style={{ fontSize: 22 }}>Delete your account?</h2>
            <p>
              Your username, email and password are removed. Old game results already recorded keep player display
              names, but they stop being linked to you. Friends and requests are deleted. This can't be undone.
            </p>
            <DeleteAccountForm onDone={() => (window.location.href = "/")} />
            <Button className="btn-ghost" onClick={() => setDeleteOpen(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Page>
  );
}

/** Password re-authentication before the destructive account delete call. */
export function DeleteAccountForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        api
          .del("/api/auth/account", { password })
          .then(onDone)
          .catch((err) => {
            setError(err instanceof ApiError ? err.message : "Could not delete the account. Try again.");
            setBusy(false);
          });
      }}
    >
      <Field label="Your password" hint="Confirm your password to delete the account.">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          aria-label="Your password"
        />
      </Field>
      <ErrorBanner error={error} />
      <Button type="submit" className="btn-primary" loading={busy}>
        Delete permanently
      </Button>
    </form>
  );
}
