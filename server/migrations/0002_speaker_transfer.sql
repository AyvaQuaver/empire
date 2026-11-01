-- Migration 0002: speaker-less loudspeaker changes are no longer "force
-- takeover" — the organiser authorizes a specific participant, and that
-- participant explicitly accepts on their own device. Authorizations are
-- short-lived, single-use and bound to a round + participant.
CREATE TABLE IF NOT EXISTS speaker_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  to_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_by_player_id TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  cancelled_at INTEGER,
  UNIQUE (round_id, to_player_id)
);
CREATE INDEX IF NOT EXISTS idx_speaker_transfers_pending
  ON speaker_transfers (round_id, to_player_id) WHERE used_at IS NULL AND cancelled_at IS NULL;
