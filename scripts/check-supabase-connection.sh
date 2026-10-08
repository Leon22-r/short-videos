#!/bin/sh
# Probes a Postgres URL from inside a container on heavy-net, the way n8n will
# reach it. Prints the server version and the pooling mode on success.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <postgres-url>" >&2
  exit 2
fi

NETWORK="n8n_heavy-net"
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  NETWORK="heavy-net"
fi

docker run --rm --network "$NETWORK" \
  -e PGCONNECT_TIMEOUT=10 \
  docker.io/library/postgres:16-alpine \
  psql "$1" -X -Atq -v ON_ERROR_STOP=1 \
    -c "SELECT 'connected: ' || version();" \
    -c "SELECT 'pooling: ' || coalesce(current_setting('pgbouncer.pool_mode', true), 'none (direct)');"
