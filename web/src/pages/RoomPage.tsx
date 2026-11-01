import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError, type RoomSnapshot, type RoomSnapshotResponse } from "../lib/api";
import { LobbyView } from "./roomviews/LobbyView";
import { WordEntryView } from "./roomviews/WordEntryView";
import { ReadingView } from "./roomviews/ReadingView";
import { PlayingView } from "./roomviews/PlayingView";
import { ResultView } from "./roomviews/ResultView";
import { Page } from "../App";

const POLL_MS = 2500;

type LoadState =
  | { kind: "loading" }
  | { kind: "member"; snapshot: RoomSnapshot }
  | { kind: "non-member"; room: { code: string; title: string; genre: string; status: string } }
  | { kind: "gone"; message: string };

/** Single controller per room: polls the authorized snapshot, reconciles by
 * polling (bounded), pauses when hidden, and delegates rendering to the
 * state-specific views. All actions go through the API server; nothing here is
 * client-authoritative. */
export default function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const visible = useRef(!document.hidden);

  const load = useCallback(async () => {
    try {
      const res = await api.get<RoomSnapshotResponse>(`/api/rooms/${code}/state`);
      if (res.member && res.snapshot) {
        setState({ kind: "member", snapshot: res.snapshot });
        setError(null);
      } else if (res.room) {
        setState({ kind: "non-member", room: { ...res.room } });
        setError(null);
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.code === "EXPIRED" || err.code === "CANCELLED")) {
        setState({ kind: "gone", message: err.message });
      } else {
        setError(err instanceof ApiError ? err.message : "Connection problem.");
      }
    }
  }, [code]);

  useEffect(() => {
    void load();
    const tick = () => {
      schedule();
      if (!visible.current) return;
      void load();
    };
    const schedule = () => {
      timer.current = window.setTimeout(tick, POLL_MS);
    };
    schedule();
    const onVis = () => {
      visible.current = !document.hidden;
      if (visible.current) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  if (state.kind === "loading") {
    return (
      <Page>
        <p className="skeleton" role="status">
          Opening the room…
        </p>
      </Page>
    );
  }
  if (state.kind === "gone") {
    return (
      <Page>
        <p className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> {state.message}
        </p>
      </Page>
    );
  }
  const bind = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      await refresh();
    }
  };

  if (state.kind === "non-member") {
    return <NonMemberCard room={state.room} />;
  }

  const snap = state.snapshot;
  if (snap.room.state === "cancelled" || snap.room.state === "expired") {
    return (
      <Page>
        <p className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> This game was {snap.room.state === "cancelled" ? "cancelled" : "closed"}.
          Words and lists have been deleted.
        </p>
      </Page>
    );
  }

  switch (snap.round.state) {
    case "lobby_open":
      return <LobbyView snap={snap} error={error} act={bind} />;
    case "collecting_words":
    case "ready_to_read":
      return <WordEntryView snap={snap} error={error} act={bind} />;
    case "reading":
      return <ReadingView snap={snap} error={error} act={bind} />;
    case "playing":
      return <PlayingView snap={snap} error={error} act={bind} />;
    case "finished":
      return <ResultView snap={snap} error={error} act={bind} />;
    default:
      return (
        <Page>
          <p className="skeleton">Waiting for the organiser…</p>
        </Page>
      );
  }
}

function NonMemberCard({ room }: { room: { code: string; title: string; genre: string; status: string } }) {
  return (
    <Page>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26 }}>{room.title}</h2>
      <div className="panel">
        <p>
          Genre: <strong>{room.genre}</strong>
        </p>
        {room.status !== "open" ? (
          <p className="error-text" role="alert">
            <span aria-hidden="true">⚠</span> This round has already started. Ask the organiser to invite you for the
            next round.
          </p>
        ) : (
          <p className="status-text">You're not in this game yet — use the code or the invitation link to join.</p>
        )}
      </div>
    </Page>
  );
}
