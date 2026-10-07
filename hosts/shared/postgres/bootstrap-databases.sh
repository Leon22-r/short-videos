#!/bin/sh
# Create one role and one database per domain, idempotently.
#
# The official Postgres entrypoint only runs docker-entrypoint-initdb.d on an
# EMPTY data directory. This volume was initialised long ago, so the init
# scripts will never run again and the whatsapp_access role and database would
# otherwise never exist. This one-shot runs on every `up` instead, and every
# statement here is safe to repeat.
#
# POSIX sh, not bash: run-migrations.sh next to this file is already /bin/sh and
# nothing here needs more. `pipefail` is not POSIX, and nothing here pipes.
#
# Identifiers and literals are quoted by Postgres itself, via format('%I'/'%L')
# over psql variables, rather than spliced into SQL by the shell. A password
# containing a single quote used to break the script; a role name could have
# broken out of its identifier.
set -eu

: "${POSTGRES_HOST:?}" "${ADMIN_USER:?}" "${ADMIN_PASSWORD:?}" "${ADMIN_DB:?}"
: "${VIDEO_DB_NAME:?}" "${VIDEO_DB_USER:?}"
: "${WHATSAPP_DB_NAME:?}" "${WHATSAPP_DB_USER:?}" "${WHATSAPP_DB_PASSWORD:?}"

# Guard against the untrusted domain being pointed at the admin role: the ALTER
# below would otherwise silently reset the cluster superuser's password.
if [ "$WHATSAPP_DB_USER" = "$VIDEO_DB_USER" ] || [ "$WHATSAPP_DB_USER" = "$ADMIN_USER" ]; then
  echo "bootstrap: WHATSAPP_DB_USER must differ from VIDEO_DB_USER and ADMIN_USER" >&2
  exit 1
fi
if [ "$WHATSAPP_DB_NAME" = "$VIDEO_DB_NAME" ]; then
  echo "bootstrap: WHATSAPP_DB_NAME must differ from VIDEO_DB_NAME" >&2
  exit 1
fi

export PGPASSWORD="$ADMIN_PASSWORD"
psql_admin() {
  psql --username "$ADMIN_USER" --host "$POSTGRES_HOST" --dbname "$ADMIN_DB" \
    --no-password --set ON_ERROR_STOP=1 \
    -v vdb="$VIDEO_DB_NAME" -v vuser="$VIDEO_DB_USER" \
    -v wdb="$WHATSAPP_DB_NAME" -v wuser="$WHATSAPP_DB_USER" -v wpass="$WHATSAPP_DB_PASSWORD" \
    "$@" || {
      status=$?
      echo "bootstrap: psql failed (exit $status). If this is an authentication" >&2
      echo "  failure on a volume that already existed, the stored password was" >&2
      echo "  set at initdb and POSTGRES_PASSWORD does not change it. See" >&2
      echo "  hosts/README.md, 'Bringing an existing volume onto this layout'." >&2
      return $status
    }
}

echo "bootstrap: ensuring role ${WHATSAPP_DB_USER}"
# CREATE ROLE has no IF NOT EXISTS, so generate it only when absent and let
# \gexec run it. format('%I') quotes the identifier; '%L' quotes the password.
psql_admin <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'wuser')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'wuser')
\gexec
-- Unconditional, so a re-run reconciles the password and the limit. The limit
-- bounds the untrusted side's share of max_connections (default 100):
-- privilege fencing stops cross-database reads but not slot exhaustion, and a
-- looping workflow on the webhook-facing instance would starve the publishing
-- queue.
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT 20', :'wuser', :'wpass')
\gexec
SQL

echo "bootstrap: ensuring database ${WHATSAPP_DB_NAME}"
# CREATE DATABASE cannot run inside a transaction or a DO block either.
psql_admin <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'wdb', :'wuser')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'wdb')
\gexec
SQL

echo "bootstrap: fencing both databases"
# Postgres grants CONNECT to PUBLIC on every new database, so fencing only the
# video one would leave the WhatsApp database readable by the publishing role.
# Both directions are closed, and each database grants CONNECT back to its own
# role explicitly.
#
# Note what this does NOT do: VIDEO_DB_USER is the cluster superuser that initdb
# created, and superusers bypass REVOKE CONNECT, so it can still reach the
# WhatsApp database. The direction that matters -- the untrusted role reaching
# the video database -- is closed. The mirrored REVOKE takes effect if that role
# is ever demoted to a non-superuser.
psql_admin <<'SQL'
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'vdb') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'vdb', :'vuser') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'wdb') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'wdb', :'wuser') \gexec
SQL

echo "bootstrap: done"
