-- Empire initial schema. Times are Unix ms UTC. Private data lives only in
-- private_* tables; public queries never join them.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_canonical TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_canonical TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- SHA-256 hash of the session token; raw token never stored
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE email_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- 'verify_email' | 'password_reset'
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT,
  -- Dev-only local "mailbox". Contains deliberately fictional addresses only.
  checked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  state TEXT NOT NULL,               -- 'open' | 'cancelled' | 'expired'
  organiser_player_id TEXT,          -- FK to players(id), declared below
  invitation_token TEXT NOT NULL UNIQUE,
  current_round_id TEXT,             -- FK to rounds(id), declared below
  next_round_id TEXT,                -- FK to rounds(id)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  locked_at INTEGER
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  display_name_canonical TEXT NOT NULL,
  join_order INTEGER NOT NULL,
  is_organiser INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'left' | 'removed'
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX players_room_active_name
  ON players(room_id, display_name_canonical) WHERE status = 'active';
CREATE UNIQUE INDEX players_room_session_active
  ON players(room_id, session_id) WHERE status = 'active';

CREATE TABLE next_round_roster (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, player_id)
);

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,               -- lobby_open | collecting_words | ready_to_read |
                                     -- reading | playing | finished | cancelled | expired
  genre TEXT NOT NULL,
  title TEXT NOT NULL,
  starter_player_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE TABLE round_roster (          -- players locked into a specific round (excludes late joiners)
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  join_order INTEGER NOT NULL,
  PRIMARY KEY (round_id, player_id)
);

CREATE TABLE round_participants (    -- snapshot of the roster at reading start; feeds history
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, player_id)
);

-- Private: word submissions. Never joined from public endpoints or sent to any client.
CREATE TABLE private_submissions (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  word_display TEXT NOT NULL,
  word_normalized TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, player_id),
  UNIQUE (round_id, word_normalized)
);

-- Private: the three independently shuffled word-only lists. Server-side only;
-- released to exactly the lease-holding speaker device.
CREATE TABLE private_reading_sequences (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  reading_number INTEGER NOT NULL,
  words_json TEXT NOT NULL,
  PRIMARY KEY (round_id, reading_number)
);

CREATE TABLE speaker_leases (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  holder_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  holder_session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  fence INTEGER NOT NULL,            -- increments on every takeover; acks must match
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  killed INTEGER NOT NULL DEFAULT 0  -- 1 = revoked/overwritten; old token can no longer act
);

-- Public playback progress only (no words): which reading, which position.
CREATE TABLE reading_progress (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  reading_number INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER NOT NULL
);

CREATE TABLE game_results (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  round_seq INTEGER NOT NULL,
  genre TEXT NOT NULL,
  winner_player_id TEXT NOT NULL REFERENCES players(id),
  winner_name TEXT NOT NULL,
  winner_user_id TEXT,
  recorded_by_player_id TEXT NOT NULL,
  recorded_by_name TEXT NOT NULL,
  recorded_by_user_id TEXT,
  recorded_at INTEGER NOT NULL,
  corrected_at INTEGER,
  correction_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (room_id, round_seq)
);

CREATE TABLE result_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  previous_winner_name TEXT NOT NULL,
  previous_winner_user_id TEXT,
  new_winner_name TEXT NOT NULL,
  new_winner_user_id TEXT,
  changed_by_name TEXT NOT NULL,
  changed_by_user_id TEXT,
  changed_at INTEGER NOT NULL
);

CREATE TABLE friendships (
  user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_low, user_high)
);

CREATE TABLE friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (from_user_id, to_user_id)
);

CREATE TABLE room_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  UNIQUE (room_id, from_user_id, to_user_id)
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
