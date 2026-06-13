#!/bin/sh
# Runs as root at container start, makes the storage directory writable by the
# non-root app user (Railway volumes mount as root-owned), then drops privileges
# to `stn` and execs the server. Standard pattern used by official Postgres/Redis
# images. Keeps the non-root security posture while allowing durable file storage.
set -e

TARGET="${STORAGE_LOCAL_DIR:-/app/server/var/storage}"
mkdir -p "$TARGET"
chown -R stn:stn "$TARGET" 2>/dev/null || true

# Also fix the volume mount root (e.g. /data) so the directory itself is writable.
PARENT=$(dirname "$TARGET")
[ -d "$PARENT" ] && chown stn:stn "$PARENT" 2>/dev/null || true

exec gosu stn "$@"
