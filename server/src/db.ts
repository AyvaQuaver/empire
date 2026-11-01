import fs from "node:fs";
import path from "node:path";
import url from "node:url";
// Type-only import: erased before bundling, so Vite never resolves `node:sqlite`;
// the runtime value comes from process.getBuiltinModule below.
import type { DatabaseSync } from "node:sqlite";

// `node:sqlite` is a recent built-in that bundler-based resolvers may not
// recognize; process.getBuiltinModule bypasses the import pipeline entirely.
const { DatabaseSync: DatabaseSyncCtor } = (
  process as unknown as { getBuiltinModule?: (m: string) => unknown }
).getBuiltinModule?.("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

// The relational source of truth. node:sqlite provides real transactions,
// foreign keys and unique constraints without native npm builds.
export type DB = DatabaseSync;

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export function openDb(dbFile: string): DB {
  const dir = path.dirname(path.resolve(dbFile));
  if (dbFile !== ":memory:" && dbFile !== "") fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSyncCtor(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, dbFile !== ":memory:" ? path.resolve(dbFile) : "");
  return db;
}

export function migrate(db: DB, _dbFile: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const migrationsDir = path.resolve(__dirname, "../migrations");
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function closeDb(db: DB): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore
  }
  db.close();
}

// Run `fn` inside an IMMEDIATE transaction. The DB layer is synchronous, so
// concurrent HTTP requests to a single process are serialized here — this is
// the "serialize conflicting updates" mechanism, combined with unique indexes.
export function withTx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
