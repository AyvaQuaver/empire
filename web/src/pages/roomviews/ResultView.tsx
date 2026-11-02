import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import type { RoomSnapshot } from "../../lib/api";
import { api } from "../../lib/api";
import { Button, ErrorBanner, Modal, Input } from "../../components/ui";
import { Page } from "../../App";
import { Crown, Confetti } from "../../components/decor";

type Act = (fn: () => Promise<unknown>) => () => Promise<void>;

/** Winner screen: a celebration, not a dashboard. The winning word is the
 * star of the show (temporary reveal, round participants only); everything
 * else is compact: attribution, one primary action, small organiser link. */
export function ResultView({ snap, error, act }: { snap: RoomSnapshot; error: string | null; act: Act }) {
  const navigate = useNavigate();
  const result = snap.result;
  const [recordOpen, setRecordOpen] = useState(false);
  const [selectedWinner, setSelectedWinner] = useState<string | null>(snap.result?.winnerPlayerId ?? null);
  const [nextRoundOpen, setNextRoundOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [revealWord, setRevealWord] = useState<string | null | undefined>(undefined); // undefined = still loading
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [replacementText, setReplacementText] = useState("");
  const [replacementBusy, setReplacementBusy] = useState(false);

  // The winning word comes from its own no-store endpoint that only round
  // participants can read; an expired reveal simply yields no word.
  useEffect(() => {
    let cancelled = false;
    setRevealWord(undefined);
    if (!result) return;
    api
      .get<{ reveal: { word: string | null; expired: boolean; canSubmitReplacement: boolean } | null }>(
        `/api/rounds/${snap.round.id}/reveal`,
      )
      .then((out) => {
        if (cancelled) return;
        setRevealWord(out.reveal?.word ?? null);
        if (out.reveal?.canSubmitReplacement) setReplacementOpen(true);
      })
      .catch(() => {
        if (cancelled) return;
        setRevealWord(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snap.round.id, result]);

  if (!result) {
    return (
      <Page>
        <p className="skeleton" role="status">
          Loading the result…
        </p>
        <ErrorBanner error={error} />
      </Page>
    );
  }

  const nameOf = (id: string) => snap.players.find((p) => p.playerId === id)?.displayName ?? "?";
  const winningWord = revealWord === undefined ? null : revealWord;

  return (
    <Page>
      <div className="celebrate" style={{ textAlign: "center" }}>
        <div aria-hidden="true" style={{ position: "relative", display: "inline-block", width: 150, height: 100 }}>
          <Confetti seed={5} />
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Crown width={110} />
          </div>
        </div>
        <h1 style={{ fontSize: 32, margin: "8px 0 0", overflowWrap: "anywhere" }}>
          {result.winnerName} takes the crown!
        </h1>
      </div>

      {/* The winning word: visually prominent, clearly tied to its genre. */}
      <div
        className="panel"
        style={{ textAlign: "center", padding: "20px 16px", marginTop: 16 }}
        aria-live="polite"
      >
        <p className="panel-heading" style={{ margin: 0 }}>The winning word was</p>
        {winningWord === null ? (
          revealWord === undefined ? (
            <p className="skeleton" role="status" style={{ margin: 0, minHeight: 44 }}>
              …
            </p>
          ) : (
            <p className="status-text" role="status" style={{ margin: "8px 0 0" }}>
              The reveal window has ended — the word is no longer shown.
            </p>
          )
        ) : (
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 40,
              margin: "10px 0 2px",
              overflowWrap: "anywhere",
            }}
          >
            {winningWord}
          </div>
        )}
        <p className="status-text" style={{ margin: "10px 0 0" }}>
          {result.genre} · {result.participants.length} player{result.participants.length === 1 ? "" : "s"}
        </p>
      </div>

      <p className="status-text" style={{ textAlign: "center" }} role="status">
        Recorded by {result.recordedByName} · organiser-reported
        {result.correctionCount > 0 ? ` · corrected ${result.correctionCount} time${result.correctionCount === 1 ? "" : "s"}` : ""}
      </p>

      {snap.me.isOrganiser ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Button className="btn-primary btn-cta" onClick={() => setNextRoundOpen(true)}>
            Play again
          </Button>
          <Link to="/how-to-play" className="btn-ghost" style={{ textAlign: "center", minHeight: 44 }}>
            How it works
          </Link>
          <Button
            className="btn-small btn-ghost"
            style={{ minHeight: 44, alignSelf: "center" }}
            onClick={() => setRecordOpen(true)}
          >
            Correct winner
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="status-text" style={{ textAlign: "center" }}>
            The organiser starts the next round when the group is ready.
          </p>
          <Link to="/how-to-play" className="btn-ghost" style={{ textAlign: "center", minHeight: 44 }}>
            How it works
          </Link>
        </div>
      )}
      {snap.auth.signedIn === false && (
        <Link
          to="/register"
          className="btn btn-secondary"
          style={{ marginTop: 6 }}
        >
          Create an account to save your history
        </Link>
      )}
      <ErrorBanner error={error} />

      {/* Winning-word replacement: only the corrected winner's own device may
          supply it (server-checked); labelled as supplied by the winner. */}
      {replacementOpen && winningWord === null && result.winnerPlayerId !== null && (
        <div className="panel" style={{ marginTop: 8 }}>
          <p className="panel-heading" style={{ margin: 0 }}>Add the winning word</p>
          <p className="status-text" style={{ marginTop: 4 }}>
            You're the corrected winner. Other guesses from the round are already deleted, so this word is supplied by
            you and labelled as such — it's shown with the result for 24 hours.
          </p>
          <Input
            value={replacementText}
            onChange={(e) => setReplacementText(e.target.value)}
            required
            maxLength={40}
            aria-label="Your winning word"
            placeholder="Your word"
          />
          <Button
            className="btn-primary"
            loading={replacementBusy}
            onClick={() =>
              void (async () => {
                if (replacementBusy) return;
                setReplacementBusy(true);
                try {
                  await api.post(`/api/rounds/${snap.round.id}/reveal-word`, { word: replacementText });
                  setReplacementOpen(false);
                  setRevealWord(replacementText.trim());
                } catch (err) {
                  setRevealWord(null);
                  setReplacementOpen(false);
                } finally {
                  setReplacementBusy(false);
                }
              })()
            }
          >
            Show my word
          </Button>
          <Button
            className="btn-ghost"
            disabled={replacementBusy}
            onClick={() => setReplacementOpen(false)}
          >
            Skip — show no word
          </Button>
        </div>
      )}

      {recordOpen && (
        <Modal title="Correct the winner" open onClose={() => setRecordOpen(false)}>
          <p>Pick the corrected winner from this round's players.</p>
          <p className="status-text">
            Remember: the shown word belongs to the previous winner and will be removed when you correct.
          </p>
          <div role="radiogroup" aria-label="Corrected winner">
            {result.participants.map((p) => (
              <div className="player-row" key={p.playerId}>
                <input
                  type="radio"
                  name="winner"
                  id={`cw-${p.playerId}`}
                  checked={selectedWinner === p.playerId}
                  onChange={() => setSelectedWinner(p.playerId)}
                  style={{ minWidth: 20, minHeight: 20 }}
                />
                <label htmlFor={`cw-${p.playerId}`} style={{ flex: 1, cursor: "pointer" }}>
                  {nameOf(p.playerId)}
                </label>
              </div>
            ))}
          </div>
          <Button
            className="btn-primary"
            loading={false}
            onClick={() =>
              void act(async () => {
                if (!selectedWinner) return;
                await api.post(`/api/rounds/${snap.round.id}/result`, { winnerPlayerId: selectedWinner });
                setRecordOpen(false);
              })()
            }
          >
            Save correction
          </Button>
        </Modal>
      )}

      {nextRoundOpen && (
        <Modal title="Play another round?" open onClose={() => setNextRoundOpen(false)}>
          <p>
            Everyone from this round stays in the group; you'll confirm the roster on the next lobby. Anyone who joined
            late can be added before you lock. New words, new shuffles.
          </p>
          <p className="status-text">
            This round's secrets are permanently deleted when you move on — including the shown winning word.
          </p>
          <Button
            className="btn-primary"
            onClick={() =>
              void act(async () => {
                await api.post(`/api/rounds/${snap.round.id}/next-round`);
                setNextRoundOpen(false);
              })()
            }
          >
            Start next round (&nbsp;{snap.rosterPreview?.confirmed.length ?? result.participants.length} players)
          </Button>
        </Modal>
      )}

      {cancelOpen && (
        <Modal title="Close this game?" open onClose={() => setCancelOpen(false)}>
          <p>The room becomes unavailable. Results and history already recorded stay as they are.</p>
          <Button
            className="btn-primary"
            onClick={() =>
              void act(async () => {
                await api.post(`/api/rooms/${snap.room.code}/cancel`);
                navigate("/");
              })()
            }
          >
            Close game
          </Button>
        </Modal>
      )}
    </Page>
  );
}
