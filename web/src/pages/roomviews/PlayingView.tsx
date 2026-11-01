import { useState } from "react";
import { Link } from "react-router-dom";
import type { RoomSnapshot } from "../../lib/api";
import { api } from "../../lib/api";
import { Avatar, Button, ErrorBanner, Modal, Panel } from "../../components/ui";
import { Page } from "../../App";

type Act = (fn: () => Promise<unknown>) => () => Promise<void>;

// Playing: "Lucy goes first. Phones down, game on." Organiser records a winner.
export function PlayingView({ snap, error, act }: { snap: RoomSnapshot; error: string | null; act: Act }) {
  const [recordOpen, setRecordOpen] = useState(false);
  const [selectedWinner, setSelectedWinner] = useState<string | null>(snap.result?.winnerPlayerId ?? null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const winnerName = snap.players.find((p) => p.playerId === selectedWinner)?.displayName ?? null;

  return (
    <Page>
      <div className={`celebrate ${snap.starter ? "" : ""}`} aria-hidden="false">
        <h1 style={{ fontSize: 30, textAlign: "center" }}>
          {snap.starter ? `${snap.starter.displayName} goes first.` : "The starter has been chosen."}
        </h1>
      </div>
      <p style={{ textAlign: "center", fontWeight: 800, fontSize: 22 }} role="status">
        Phones down, game on.
      </p>
      <Panel heading="How the physical round plays (house rules are yours!)">
        <ul className="manual-list">
          <li>Player {snap.starter ? snap.starter.displayName : ""} starts. Someone guesses another player's word.</li>
          <li>Correct guess: that player joins the guesser's empire.</li>
          <li>Wrong guess: turn passes to the player who was guessed.</li>
          <li>Keep going! Goal: build the biggest empire.</li>
        </ul>
        <Link to="/how-to-play" className="btn-ghost" style={{ minHeight: 44 }}>
          Full how-to-play
        </Link>
      </Panel>
      {snap.me.isOrganiser ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Button className="btn-primary btn-cta" onClick={() => setRecordOpen(true)}>
            Record winner
          </Button>
          <Button className="btn-ghost" onClick={() => setCancelOpen(true)}>
            Cancel round (no winner)
          </Button>
        </div>
      ) : (
        <p className="status-text" style={{ textAlign: "center" }} role="status">
          The organiser will record the winner when the game ends.
        </p>
      )}
      <ErrorBanner error={error} />

      {recordOpen && !reviewOpen && (
        <Modal title="Who takes the crown?" open onClose={() => setRecordOpen(false)}>
          <p>Choose exactly one player from this round.</p>
          <div role="radiogroup" aria-label="Winner">
            {snap.players.map((p) => (
              <div className="player-row" key={p.playerId}>
                <input
                  type="radio"
                  name="winner"
                  id={`winner-${p.playerId}`}
                  checked={selectedWinner === p.playerId}
                  onChange={() => setSelectedWinner(p.playerId)}
                  style={{ minWidth: 20, minHeight: 20 }}
                />
                <label htmlFor={`winner-${p.playerId}`} style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <Avatar name={p.displayName} playerId={p.playerId} />
                  <span className="player-name">{p.displayName}</span>
                </label>
              </div>
            ))}
          </div>
          <Button
            className="btn-primary"
            disabled={!selectedWinner}
            onClick={() => {
              setReviewOpen(true);
            }}
          >
            Review selection
          </Button>
        </Modal>
      )}

      {reviewOpen && (
        <Modal title="Confirm the winner" open onClose={() => setReviewOpen(false)}>
          <p style={{ fontSize: 20 }}>
            <strong>{winnerName}</strong> wins {snap.room.genre}?
          </p>
          <p className="status-text">Results are organiser-reported. You'll be able to correct this later.</p>
          <Button
            className="btn-primary"
            onClick={() =>
              void act(async () => {
                if (!selectedWinner) return;
                await api.post(`/api/rounds/${snap.round.id}/result`, { winnerPlayerId: selectedWinner });
                setRecordOpen(false);
                setReviewOpen(false);
              })()
            }
          >
            Save result
          </Button>
          <Button className="btn-ghost" onClick={() => setReviewOpen(false)}>
            Back
          </Button>
        </Modal>
      )}

      {cancelOpen && (
        <Modal title="Cancel this round?" open onClose={() => setCancelOpen(false)}>
          <p>This round doesn't count as a completed game and no winner is recorded.</p>
          <Button
            className="btn-primary"
            onClick={() =>
              void act(async () => {
                await api.post(`/api/rooms/${snap.room.code}/cancel-round`);
                setCancelOpen(false);
              })()
            }
          >
            Cancel round
          </Button>
          <Button className="btn-ghost" onClick={() => setCancelOpen(false)}>
            Back
          </Button>
        </Modal>
      )}

      {snap.me.isOrganiser ? null : null}
    </Page>
  );
}
