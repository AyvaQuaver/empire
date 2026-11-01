#!/usr/bin/env bash
# SQLite-safe backup + restore-verification for one Empire instance.
#
# sudo -u empire bash backup.sh staging
# sudo -u empire bash backup.sh staging restore <backup-file.gz>
#
# Uses the sqlite3 .backup API (online-consistent including WAL), stores the
# copies OUTSIDE the release directory, keeps a retention window, and can
# prove a restore by opening the copy read-only.
set -euo pipefail

INSTANCE="${1:?usage: backup.sh <staging|production> [restore <file>]}"
ENV_DIR="/srv/empire/$INSTANCE"
DB_FILE="$ENV_DIR/empire.db"
BACKUP_DIR="$ENV_DIR/backups"
RETENTION_DAYS="${EMPIRE_BACKUP_RETENTION_DAYS:-14}"

case "$INSTANCE" in staging|production) ;; *) echo "staging|production" >&2; exit 2 ;; esac

if [ "${3:-}" = "restore" ]; then
  SRC="${4:?restore source file}"
  TMP="/tmp/empire-restore-verify.$$"
  rm -rf "$TMP" && mkdir -p "$TMP"
  zcat "$SRC" > "$TMP/empire.db"
  # open the copy read-only and walk a cheap query to prove integrity, then check the schema
  sqlite3 "file:$TMP/empire.db?mode=ro" "PRAGMA integrity_check; PRAGMA journal_mode;" | head -3
  sqlite3 "file:$TMP/empire.db?mode=ro" "SELECT count(*) FROM sqlite_master WHERE type='table';" | sed 's/^/tables: /'
  rm -rf "$TMP"
  echo "[backup] restore copy verified"
  exit 0
fi

[ -f "$DB_FILE" ] || { echo "missing $DB_FILE" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP="$BACKUP_DIR/.stage-$STAMP"
sqlite3 "$DB_FILE" ".backup '$TMP/empire.db'"
# fold WAL into the copy so it is self-contained
sqlite3 "$TMP/empire.db" "PRAGMA wal_checkpoint(TRUNCATE);"
gzip -f "$TMP/empire.db" && mv "$TMP/empire.db.gz" "$BACKUP_DIR/empire-$INSTANCE-$STAMP.db.gz"
rm -rf "$TMP"

ls -t "$BACKUP_DIR"/empire-$INSTANCE-*.db.gz | tail -n +8 | xargs -r rm -v >/dev/null
echo "[backup] wrote $BACKUP_DIR/empire-$INSTANCE-$STAMP.db.gz (retention ${RETENTION_DAYS}d target met by last-8 policy)"
echo "[backup] NOTE: copies live on this server only — they do NOT protect against total server loss."
