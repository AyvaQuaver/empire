-- Migration 0005: speaker pacing. Round-authoritative "pause between words"
-- chosen from the allowed set {1000,1500,2000,3000} ms; NULL falls back to the
-- 1000 default. Only the organiser (before readings start) or the holding
-- speaker (before playback/while paused) may set it; a replacement speaker
-- inherits the round's value.
ALTER TABLE rounds ADD COLUMN word_pause_ms INTEGER;
