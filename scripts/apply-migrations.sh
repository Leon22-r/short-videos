#!/bin/sh
# Applies migrations against any target Postgres URL and logs each run into short_videos.schema_migrations.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <database-url> [migrations-dir]" >&2
  exit 2
fi

TARGET_URL="$1"
MIGRATIONS_DIR="${2:-domains/short-videos/postgres/migrations}"

psql --set ON_ERROR_STOP=1 "$TARGET_URL" -c "
  CREATE SCHEMA IF NOT EXISTS short_videos;
  CREATE TABLE IF NOT EXISTS short_videos.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
"

for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  version="$(basename "$migration")"
  echo "Applying $version..."
  psql --set ON_ERROR_STOP=1 "$TARGET_URL" --file "$migration"
  psql --set ON_ERROR_STOP=1 "$TARGET_URL" -c "
    INSERT INTO short_videos.schema_migrations (version, applied_at)
    VALUES ('$version', now())
    ON CONFLICT (version) DO UPDATE SET applied_at = now();
  "
done

echo "Migrations complete."
