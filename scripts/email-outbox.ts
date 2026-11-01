import { config } from "../server/src/config.js";
import type { DB } from "../server/src/db.js";

// Dev-only CLI replacement for the old /api/dev/outbox browser route.
// Local machine use:  ALLOW_DEV_EMAIL_PREVIEW=true npm run email:outbox
// Refuses to run anywhere except a local development environment, so it can
// never become an equivalent of an exposed HTTP preview behind a proxy/tunnel.

const allow = process.env.ALLOW_DEV_EMAIL_PREVIEW === "true";

if (!allow) {
  console.error(
    "Refusing to read the outbox: set ALLOW_DEV_EMAIL_PREVIEW=true to enable this development-only tool.",
  );
  process.exit(1);
}
if (config.nodeEnv !== "development") {
  console.error(
    `Refusing to read the outbox: this CLI is development-only (current EMPIRE_ENV=${config.nodeEnv}).`,
  );
  process.exit(1);
}

const { openDb } = await import("../server/src/db.js");
const db: DB = openDb(config.dbFile);
const rows = db
  .prepare("SELECT id, to_email, subject, body, created_at FROM email_outbox ORDER BY id DESC LIMIT 50")
  .all() as { id: number; to_email: string; subject: string; body: string; created_at: number }[];
console.log(`[email:outbox] ${rows.length} message(s)`);
for (const r of rows) {
  console.log(`--- #${r.id} to=${r.to_email} (${new Date(r.created_at).toLocaleString()})`);
  console.log(r.body);
}
