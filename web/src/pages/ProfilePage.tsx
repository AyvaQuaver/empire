import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Button, ErrorBanner, Field, Input, Panel } from "../components/ui";
import { Page, useSession } from "../App";
import { SignOutButton } from "./AuthPages";

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

/** Profile: private to the account owner. Games played, wins, dated history,
 * friends link, account management. A genuine empty state until real results. */
export function ProfilePage() {
  const session = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  const [games, setGames] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

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
        <p>Sign in to see your game history, stats and friends. Playing as a guest doesn't need an account.</p>
        <Link to="/sign-in" className="btn btn-primary">
          Sign in
        </Link>
        <Link to="/register" className="btn btn-secondary">
          Create an account
        </Link>
      </Page>
    );
  }

  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>{session.username}</h1>
      {!session.emailVerified && (
        <p className="status-text">
          Email not verified yet.{" "}
          <Link to="/verify-email" style={{ minHeight: 44 }}>
            Resend link
          </Link>
        </p>
      )}
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }} >
          <Panel className="panel-tight">
            <p className="panel-heading">Games played</p>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 800 }}>{stats?.gamesPlayed ?? "…"}</div>
          </Panel>
        </div>
        <div style={{ flex: 1 }}>
          <Panel className="panel-tight">
            <p className="panel-heading">Wins</p>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 800 }}>👑 {stats?.wins ?? "…"}</div>
          </Panel>
        </div>
      </div>

      <Panel heading="Game history">
        {games === null ? (
          <p className="skeleton">Loading…</p>
        ) : games.length === 0 ? (
          <p className="status-text">
            No finished games yet. Wins show here once the organiser records a result — completed rounds only.
          </p>
        ) : (
          <ul className="manual-list" style={{ padding: 0 }}>
            {games.map((g) => (
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
      <SignOutButton />
      <Button className="btn-ghost" onClick={() => setDeleteOpen(true)}>
        Delete account
      </Button>
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
