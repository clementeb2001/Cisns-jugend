#!/bin/sh
# Tägliches, konsistentes Backup der SQLite-Datenbank via better-sqlite3 Online-Backup.
# Läuft als eigener Container (siehe docker-compose.yml). Behält BACKUP_KEEP_DAYS Tage.
set -eu

DB_PATH="${DB_PATH:-/data/jugendfeuerwehr.db}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

mkdir -p "$BACKUP_DIR"

do_backup() {
  TS=$(date +%Y%m%d_%H%M%S)
  OUT="$BACKUP_DIR/jugendfeuerwehr_$TS.db"
  # Online-Backup (sicher auch während Schreibzugriffen, WAL-kompatibel)
  node -e "
    const Database = require('/app/node_modules/better-sqlite3');
    const db = new Database(process.env.DB_PATH, { readonly: true });
    db.backup(process.argv[1]).then(() => { console.log('Backup: ' + process.argv[1]); process.exit(0); })
      .catch((e) => { console.error(e); process.exit(1); });
  " "$OUT"
  # Alte Backups aufräumen
  find "$BACKUP_DIR" -name 'jugendfeuerwehr_*.db' -type f -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
}

echo "Backup-Dienst gestartet (Intervall ${INTERVAL}s, Aufbewahrung ${KEEP_DAYS} Tage)."
while true; do
  do_backup || echo "Backup fehlgeschlagen ($(date))"
  sleep "$INTERVAL"
done
