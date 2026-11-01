-- Migration 0003b: minimal email delivery diagnostics (no bodies, subjects,
-- recipients, tokens or raw SMTP error text — those never enter storage in
-- deployed environments).
CREATE TABLE IF NOT EXISTS email_delivery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- verify_email | password_reset | email
  status TEXT NOT NULL,             -- sent | failed | stored
  error_code TEXT,                  -- safe identifier only (e.g. "ENOTFOUND"); no raw error text
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_log_created
  ON email_delivery_log (created_at);
