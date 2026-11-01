import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import type { RoomSnapshot } from "../../lib/api";
import { api } from "../../lib/api";
import { Avatar, Button, ErrorBanner, Modal, Panel } from "../../components/ui";
import { Page } from "../../App";

type Act = (fn: () => Promise<unknown>) => () => Promise<void>;

/* Result: "[Name] takes the crown." Organiser-reported result, with correction
 * for the organiser and Play another round (fresh round, fresh secrets). */
export function ResultView({ snap, error, act }: { snap: RoomSnapshot; error: string | null; act: Act }) {
  const navigate = useNavigate();
  const result = snap.result;
  const [recordOpen, setRecordOpen] = useState(false);
  const [selectedWinner, setSelectedWinner] = useState<string | null>(snap.result?.winnerPlayerId ?? null);
  const [nextRoundOpen, setNextRoundOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

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

  return (
    <Page>
      <div className="celebrate" style={{ textAlign: "center" }}>
        <svg width="90" height="55" viewBox="0 0 260 162" fill="none" aria-hidden="true">
          <path
            d="M36 118 C 30 108, 34 96, 40 78 C 46 62, 54 44, 60 32 C 63 26, 69 25, 73 30 C 88 48, 102 66, 112 78 C 118 60, 124 44, 132 30 C 136 22, 144 22, 148 30 C 154 44, 160 60, 166 76 C 178 64, 192 50, 208 36 C 214 31, 221 34, 222 41 C 226 68, 232 96, 226 112 C 220 128, 200 136, 170 140 C 140 144, 90 144, 64 136 C 48 131, 40 126, 36 118 Z"
            fill="#FF684F"
          />
        </svg>
        <h1 style={{ fontSize: 30 }}>
          {result.winnerName} takes the crown!
        </h1>
      </div>
      <p className="status-text" style={{ textAlign: "center" }} role="status">
        Recorded by {result.recordedByName} · organiser-reported
        {result.correctionCount > 0 ? ` · corrected ${result.correctionCount} time${result.correctionCount === 1 ? "" : "s"}` : ""}
      </p>
      <Panel heading={`Round ${result.roundSeq} · ${result.genre}`}>
        {result.isOrganiser && (
          <Button className="btn-small btn-ghost" style={{ minHeight: 44 }} onClick={() => setRecordOpen(true)}>
            Correct the winner
          </Button>
        )}
        <ul className="manual-list" style={{ marginTop: 8 }}>
          {result.participants.map((p) => (
            <li key={p.playerId} style={{ listStyle: "none" }}>
              <span className="player-row" style={{ padding: 0 }}>
                <Avatar name={p.name} playerId={p.playerId} />
                <span className="player-name" style={{ fontWeight: p.playerId === result.winnerPlayerId ? 800 : 500 }}>
                  {p.name}
                  {p.playerId === result.winnerPlayerId ? " 👑" : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      {snap.me.isOrganiser ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Button className="btn-primary btn-cta" onClick={() => setNextRoundOpen(true)}>
            Play another round
          </Button>
          <Button className="btn-ghost" onClick={() => setCancelOpen(true)}>
            Close this game
          </Button>
        </div>
      ) : (
        <p className="status-text" style={{ textAlign: "center" }}>
          Ask the organiser to play another round, or{" "}
          <Link to="/" className="btn-ghost" style={{ minHeight: 44 }}>
            go home
          </Link>
          .
        </p>
      )}
      <ErrorBanner error={error} />

      {recordOpen && (
        <Modal title="Correct the winner" open onClose={() => setRecordOpen(false)}>
          <p>Pick the corrected winner from this round's players.</p>
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
            This round's saved words and readings are permanently deleted when you move on.
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
