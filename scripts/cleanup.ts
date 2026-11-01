// Standalone cleanup run for cron/CI:
//   npm run cleanup
import { config } from "../server/src/config.js";
import { openDb, closeDb } from "../server/src/db.js";
import { runCleanup } from "../server/src/services/cleanup.js";

const db = openDb(config.dbFile);
const out = runCleanup(db);
console.log(`[cleanup] expiredRooms=${out.expiredRooms} expiredTokens=${out.expiredTokens}`);
closeDb(db);
