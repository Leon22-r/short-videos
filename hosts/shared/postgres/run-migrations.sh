#!/bin/sh
set -eu

for migration in /migrations/*.sql; do
  [ -f "$migration" ] || continue
  psql --set ON_ERROR_STOP=1 "$DATABASE_URL" --file "$migration"
done
