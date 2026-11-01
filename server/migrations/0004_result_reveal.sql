-- Migration 0004: temporary winning-word reveal. The organiser-reported result
-- mistakes no secrets: at result save time the WINNING word is copied here from
-- the private submissions (which are then destroyed), so the round's winner
-- word can be shown on the results screen for 24h. Only round participants may
-- read it; corrections clear the word until the newly corrected winner opts to
-- re-submit it themselves. History never retains words.
CREATE TABLE IF NOT EXISTS result_reveals (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  result_version INTEGER NOT NULL DEFAULT 1,
  winner_player_id TEXT NOT NULL REFERENCES players(id),
  word TEXT,                      -- NULL after a correction until the corrected
                                  -- winner supplies a replacement
  source TEXT NOT NULL,           -- 'original' | 'replacement'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
