import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import type { RoomSnapshot } from "../../lib/api";
import { api } from "../../lib/api";
import { Avatar, Button, ErrorBanner, Field, Input, Modal, Panel } from "../../components/ui";
import { Page } from "../../App";

type Act = (fn: () => Promise<unknown>) => () => Promise<void>;

// Lobby: "Gather your people." Room identity, shareable code, real QR,
// player list with organiser badge. Organiser controls are confirmed where
// destructive, per spec.
export function LobbyView({ snap, error, act }: { snap: RoomSnapshot; error: string | null; act: Act }) {
  const navigate = useNavigate();
  const isOrganiser = snap.me.isOrganiser;
  const minPlayers = snap.round.minPlayers;
  const [editingGenre, setEditingGenre] = useState(false);
  const [genre, setGenre] = useState(snap.room.genre);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const catchable = (fn: () => Promise<unknown>) => () => {
    void act(fn)();
  };

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(snap.invitationUrl, { margin: 1, width: 180, color: { dark: "#29143f", light: "#ffffff" } }).then(
      (url) => {
        if (!cancelled) setQr(url);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [snap.invitationUrl]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: snap.room.title, text: `Join our Empire game: ${snap.room.code}`, url: snap.invitationUrl });
        return;
      } catch {
        // fall back to copy
      }
    }
    void copy(snap.invitationUrl, "Link copied");
  };

  const nameOf = (id: string) => snap.players.find((p) => p.playerId === id)?.displayName ?? "?";

  const canLock = (snap.rosterPreview?.confirmed.length ?? 0) >= minPlayers;

  return (
    <Page>
      <h1 style={{ fontSize: 30 }}>Gather your people</h1>
      <div className="panel">
        <h3 className="panel-heading">Room code</h3>
        <div className="code-display" aria-label={`Room code ${snap.room.code.split("").join(" ")}`}>
          {snap.room.code.split("").join(" ")}
        </div>
        <div className="qr-box" style={{ marginTop: 12 }}>
          {qr ? (
            <img src={qr} width={170} height={170} alt={`QR code inviting people to join room ${snap.room.code}`} />
          ) : (
            <span className="skeleton">Making QR…</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Button className="btn-small btn-secondary" onClick={catchable(() => copy(snap.invitationUrl, "Link copied"))}>
            Copy link
          </Button>
          <Button className="btn-small btn-secondary" onClick={catchable(share)}>
            Share
          </Button>
          {copied && (
            <span className="status-text" role="status">
              {copied}
            </span>
          )}
        </div>
      </div>

      <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 className="panel-heading">Genre</h3>
          <span style={{ fontWeight: 700 }}>{snap.room.genre}</span>
        </div>
        {isOrganiser && snap.round.state === "lobby_open" && !editingGenre && (
          <Button className="btn-small btn-ghost" onClick={() => setEditingGenre(true)}>
            Edit
          </Button>
        )}
      </div>
      {editingGenre && (
        <form
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault();
            void act(() => apiPatchGenre(snap.room.code, genre))();
            setEditingGenre(false);
          }}
        >
          <Field label="Genre">
            <Input value={genre} onChange={(e) => setGenre(e.target.value)} maxLength={60} required />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="submit" className="btn-small btn-primary">
              Save genre
            </Button>
            <Button
              type="button"
              className="btn-small btn-ghost"
              onClick={() => {
                setEditingGenre(false);
                setGenre(snap.room.genre);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      <Panel heading={`Players (${snap.players.length})`}>
        {snap.players.map((p) => {
          const confirmed = snap.rosterPreview?.confirmed.includes(p.playerId) ?? true;
          return (
            <div className="player-row" key={p.playerId}>
              <Avatar name={p.displayName} playerId={p.playerId} />
              <span className="player-name">
                {p.displayName}
                {p.isOrganiser ? " " : ""}
                {p.isOrganiser && <span className="badge">Organiser</span>}
              </span>
              {!confirmed && isOrganiser && (
                <Button
                  className="btn-small btn-secondary"
                  onClick={catchable(() => apiNextRoster(snap.room.code, { addPlayerId: p.playerId }))}
                >
                  Add
                </Button>
              )}
              {confirmed && !p.isMe && isOrganiser && (
                <Button className="btn-small btn-ghost" onClick={() => setConfirmRemove(p.playerId)}>
                  Remove
                </Button>
              )}
            </div>
          );
        })}
        {snap.rosterPreview && (snap.rosterPreview.confirmed.length ?? 0) < minPlayers && (
          <p className="status-text">
            You need at least {minPlayers} players to lock the round ({snap.rosterPreview.confirmed.length} confirmed).
          </p>
        )}
      </Panel>

      {isOrganiser && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Button
            className="btn-primary btn-cta"
            disabled={!canLock}
            onClick={catchable(() => apiLock(snap.room.code))}
          >
            Lock room &amp; choose words
          </Button>
          <Button className="btn-ghost" onClick={() => setConfirmCancel(true)}>
            Cancel game
          </Button>
        </div>
      )}
      {!isOrganiser && (
        <Button className="btn-ghost" onClick={catchable(() => apiLeave(snap.room.code))}>
          Leave game
        </Button>
      )}
      <p className="status-text">
        Anyone with this code can join while the room is open. Lock the room to start picking words.
      </p>
      <ErrorBanner error={error} />

      <Modal
        open={!!confirmRemove}
        title={`Remove ${confirmRemove ? nameOf(confirmRemove) : "this player"}?`}
        onClose={() => setConfirmRemove(null)}
      >
        <p>This can't be undone for this round, and their saved word (if any) is deleted.</p>
        <Button
          className="btn-primary"
          onClick={catchable(async () => {
            if (confirmRemove) await apiRemove(snap.room.code, confirmRemove);
          })}
        >
          Remove player
        </Button>
      </Modal>
      <Modal open={confirmCancel} title="Cancel this game?" onClose={() => setConfirmCancel(false)}>
        <p>
          Everyone stays in the room; the words and readings for this round are deleted. Cancelled rounds don't count as
          games.
        </p>
        <Button
          className="btn-primary"
          onClick={catchable(async () => {
            await apiCancel(snap.room.code);
            navigate("/");
          })}
        >
          Cancel game
        </Button>
      </Modal>
    </Page>
  );
}


// thin wrappers so the view stays free of fetch details
const apiPatchGenre = (code: string, genre: string) => api.patch(`/api/rooms/${code}`, { genre });
const apiNextRoster = (code: string, body: { addPlayerId?: string }) => api.patch(`/api/rooms/${code}/next-roster`, body);
const apiLock = (code: string) => api.post(`/api/rooms/${code}/lock`);
const apiLeave = (code: string) => api.post(`/api/rooms/${code}/leave`);
const apiRemove = (code: string, playerId: string) => api.post(`/api/rooms/${code}/remove`, { playerId });
const apiCancel = (code: string) => api.post(`/api/rooms/${code}/cancel`);
