#!/bin/sh
# Runs migrations against TARGET_URL and records to schema_migrations.
# Used both by docker container entrypoints and scripts/apply-migrations.sh.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"
REPO_ROOT=""
if [ -n "$SCRIPT_DIR" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || echo "")"
fi

TARGET_URL="${1:-${DATABASE_URL:-}}"
if [ -z "$TARGET_URL" ]; then
  echo "usage: $0 <database-url> [migrations-dir]" >&2
  exit 2
fi

# Detect migrations directory:
if [ "$#" -ge 2 ] && [ -n "$2" ]; then
  MIGRATIONS_DIR="$2"
elif [ -d "/migrations" ]; then
  MIGRATIONS_DIR="/migrations"
elif [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/domains/short-videos/postgres/migrations" ]; then
  MIGRATIONS_DIR="$REPO_ROOT/domains/short-videos/postgres/migrations"
else
  MIGRATIONS_DIR="${PWD}/domains/short-videos/postgres/migrations"
fi

# Create schema_migrations table if database supports/has short_videos schema
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

  psql --set ON_ERROR_STOP=1 --single-transaction -v v="$version" "$TARGET_URL" << EOSQL
\i $migration
INSERT INTO short_videos.schema_migrations (version, applied_at)
VALUES (:'v', now())
ON CONFLICT (version) DO UPDATE SET applied_at = now();
EOSQL
done

echo "Migrations completed successfully."
