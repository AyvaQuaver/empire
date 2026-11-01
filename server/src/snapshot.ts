import { GAME } from "./config.js";
import type { DB } from "./db.js";
import { activePlayers, findActivePlayerForSession, getRound, rosterForRound, type RoomRow } from "./services/rooms.js";
import { getResult, resultView } from "./services/results.js";
import { progressFor, rosterReadiness, getLease, getStarterPlayer } from "./services/rounds.js";

// The one authorized snapshot per request. Also returned NULL when the caller
// is not currently an active member (routes then offer the join flow).
// No function here ever inspects another player's word.

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
    ready: boolean | null; // readiness status only; never what the word is
  }[];
  rosterPreview: { confirmed: string[]; waiting: string[] } | null;
  readiness: { ready: number; total: number } | null;
  myWord: string | null;
  canSubmitWord: boolean;
  reading: { held: boolean; mine: boolean; readingNumber: number; position: number } | null;
  speakerActive: boolean;
  starter: { playerId: string; displayName: string } | null;
  result: null | ReturnType<typeof resultView>;
  invitationUrl: string;
}

export function buildRoomSnapshot(db: DB, room: RoomRow, sessionId: string, baseUrl: string): RoomSnapshot | null {
  const me = findActivePlayerForSession(db, room.id, sessionId);
  const round = getRound(db, room.current_round_id);
  if (!me || !round) return null;

  const userRow = db
    .prepare("SELECT username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?")
    .get(sessionId) as { username: string } | undefined;

  const players = activePlayers(db, room.id);
  const roster = rosterForRound(db, round.id);
  const rosterIds = new Set(roster.map((p) => p.id));
  const showReady = round.state === "collecting_words" || round.state === "ready_to_read";
  const readinessMap = showReady ? rosterReadiness(db, round.id) : null;

  const playerViews = players.map((p) => ({
    playerId: p.id,
    displayName: p.display_name,
    isOrganiser: p.is_organiser === 1,
    isMe: p.id === me.id,
    inRoster: rosterIds.has(p.id),
    ready: readinessMap ? (readinessMap.get(p.id) ?? false) : null,
  }));

  const lease = getLease(db, round.id);
  const leaseActive = !!lease && lease.killed === 0 && lease.expires_at > Date.now();
  const progress = round.state === "reading" ? progressFor(db, round.id) : null;
  const resultRow = getResult(db, round.id);
  const starterPlayer =
    round.state === "playing" || round.state === "finished" ? getStarterPlayer(db, round) : null;

  let rosterPreview: RoomSnapshot["rosterPreview"] = null;
  if (round.state === "lobby_open") {
    const confirmedRows = db
      .prepare(
        "SELECT x.player_id AS player_id FROM next_round_roster x JOIN players p ON p.id = x.player_id WHERE x.room_id = ? AND p.status = 'active'",
      )
      .all(room.id) as { player_id: string }[];
    const confirmed = confirmedRows.map((r) => r.player_id);
    rosterPreview = {
      confirmed,
      waiting: players.filter((p) => !confirmed.includes(p.id)).map((p) => p.id),
    };
  }

  const total = rosterIds.size;
  const readyTotal = showReady
    ? roster.filter((p) => (readinessMap?.get(p.id) ?? false)).length
    : 0;

  const myWordRow = db
    .prepare("SELECT word_display FROM private_submissions WHERE round_id = ? AND player_id = ?")
    .get(round.id, me.id) as { word_display: string } | undefined;

  return {
    me: {
      playerId: me.id,
      displayName: me.display_name,
      isOrganiser: me.is_organiser === 1,
      inRoster: rosterIds.has(me.id),
    },
    auth: { signedIn: !!userRow, username: userRow?.username ?? null },
    room: { code: room.code, title: room.title, genre: room.genre, state: room.state },
    round: {
      id: round.id,
      seq: round.seq,
      state: round.state,
      minPlayers: GAME.minPlayers,
      maxPlayers: GAME.maxPlayers,
    },
    players: playerViews,
    rosterPreview,
    readiness: showReady ? { ready: readyTotal, total } : null,
    myWord: myWordRow ? myWordRow.word_display : null,
    canSubmitWord: round.state === "collecting_words" || round.state === "ready_to_read",
    reading: progress
      ? {
          held: leaseActive,
          mine: leaseActive && lease.holder_session_id === sessionId,
          readingNumber: progress.reading_number,
          position: progress.position,
        }
      : null,
    speakerActive: leaseActive,
    starter: starterPlayer ? { playerId: starterPlayer.id, displayName: starterPlayer.display_name } : null,
    result: resultRow || round.state === "finished" ? resultView(db, room, sessionId) : null,
    invitationUrl: `${baseUrl}/join/${room.invitation_token}`,
  };
}
