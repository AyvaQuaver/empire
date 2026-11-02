-- Migration 0006: account profile. display_name is the public name (editable,
-- NOT the sign-in username, which stays canonical/unique); avatar_color is a
-- curated palette key persisted so the initial stays consistent across
-- refreshes and devices. Backfill seeds display names from usernames; the
-- avatar colour is assigned by the application deterministically the first
-- time a user is read (a single id-stable UPDATE, never a random re-roll).
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_color TEXT;
UPDATE users SET display_name = username WHERE display_name IS NULL;
