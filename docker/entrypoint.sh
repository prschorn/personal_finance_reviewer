#!/bin/sh
# Restore the database shipped in the image into the persistent volume, but only
# when the volume is empty. On every later start the volume's copy wins, so data
# written inside the container is never clobbered by a rebuild.
set -e

DB_PATH="${FINANCE_DB_PATH:-/data/finance.db}"
mkdir -p "$(dirname "$DB_PATH")"

if [ -f "$DB_PATH" ]; then
  echo "[entrypoint] using existing database at $DB_PATH"
elif [ -f /app/seed-db/finance.db ]; then
  echo "[entrypoint] seeding $DB_PATH from the snapshot baked into the image"
  cp /app/seed-db/finance.db "$DB_PATH"
  if [ -f /app/seed-db/finance.db-wal ]; then
    cp /app/seed-db/finance.db-wal "$DB_PATH-wal"
  fi
else
  echo "[entrypoint] no snapshot in image; starting empty (migrations will create it)"
fi

exec "$@"
