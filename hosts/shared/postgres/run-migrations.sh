#!/bin/sh
set -eu

MIGRATIONS_DIR="${1:-/migrations}"
TARGET_URL="${2:-$DATABASE_URL}"

for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  psql --set ON_ERROR_STOP=1 "$TARGET_URL" --file "$migration"
done
