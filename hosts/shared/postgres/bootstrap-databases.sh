#!/usr/bin/env bash
# Create one role and one database per domain, idempotently.
#
# The official Postgres entrypoint only runs docker-entrypoint-initdb.d on an
# EMPTY data directory. This volume was initialised long ago, so the init
# scripts will never run again and the whatsapp_access role and database would
# otherwise never exist. This one-shot runs on every `up` instead, and every
# statement here is safe to repeat.
set -euo pipefail

: "${POSTGRES_HOST:?}" "${ADMIN_USER:?}" "${ADMIN_PASSWORD:?}" "${ADMIN_DB:?}"
: "${VIDEO_DB_NAME:?}" "${VIDEO_DB_USER:?}"
: "${WHATSAPP_DB_NAME:?}" "${WHATSAPP_DB_USER:?}" "${WHATSAPP_DB_PASSWORD:?}"

export PGPASSWORD="$ADMIN_PASSWORD"
psql_admin() { psql --username "$ADMIN_USER" --host "$POSTGRES_HOST" --dbname "$ADMIN_DB" \
  --no-password --set ON_ERROR_STOP=1 "$@"; }

echo "bootstrap: ensuring role ${WHATSAPP_DB_USER}"
psql_admin <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WHATSAPP_DB_USER}') THEN
    CREATE ROLE "${WHATSAPP_DB_USER}" LOGIN PASSWORD '${WHATSAPP_DB_PASSWORD}';
  ELSE
    ALTER ROLE "${WHATSAPP_DB_USER}" LOGIN PASSWORD '${WHATSAPP_DB_PASSWORD}';
  END IF;
END
\$\$;
-- Bounds the untrusted side's share of max_connections (default 100). Privilege
-- fencing stops cross-database reads but not slot exhaustion: a looping workflow
-- on the webhook-facing instance would otherwise starve the publishing queue.
ALTER ROLE "${WHATSAPP_DB_USER}" CONNECTION LIMIT 20;
SQL

echo "bootstrap: ensuring database ${WHATSAPP_DB_NAME}"
# CREATE DATABASE cannot run inside a transaction or a DO block, so generate the
# statement and let \gexec run it only when the database is absent.
psql_admin <<SQL
SELECT format('CREATE DATABASE %I OWNER %I', '${WHATSAPP_DB_NAME}', '${WHATSAPP_DB_USER}')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${WHATSAPP_DB_NAME}')
\gexec
SQL

echo "bootstrap: fencing both databases"
# Postgres grants CONNECT to PUBLIC on every new database, so fencing only the
# video one would leave the WhatsApp database readable by the publishing role.
# Both directions are closed, and each database grants CONNECT back to its own
# role explicitly — the owner holds that right by ownership, so this is
# insurance against ownership diverging later rather than a fix for today.
psql_admin <<SQL
REVOKE CONNECT ON DATABASE "${VIDEO_DB_NAME}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${VIDEO_DB_NAME}" TO "${VIDEO_DB_USER}";
REVOKE CONNECT ON DATABASE "${WHATSAPP_DB_NAME}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${WHATSAPP_DB_NAME}" TO "${WHATSAPP_DB_USER}";
SQL

echo "bootstrap: done"
