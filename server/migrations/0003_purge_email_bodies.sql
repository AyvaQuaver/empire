-- Migration 0003: after the SMTP-vs-dev-outbox split, email BODIES (which can
-- contain token-bearing verification/reset links) are persisted ONLY in
-- explicitly enabled local development. Previously stored bodies are purged
-- (there are deliberately no backups of these transient fixtures) and any
-- outstanding (unused, unexpired) email tokens are invalidated. Accounts and
-- game data are untouched.
DELETE FROM email_outbox;
UPDATE email_tokens
   SET expires_at = 0
 WHERE used_at IS NULL
   AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000;
