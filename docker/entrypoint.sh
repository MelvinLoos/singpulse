#!/bin/sh
# SingPulse container entrypoint.
#
# Docker creates missing bind-mount sources (./singpulse-cache) owned by root,
# which the unprivileged runtime user could not write to. When started as root,
# take ownership of the cache directory, then drop privileges to `node` for the
# actual server process.
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CACHE_DIR"
  chown node:node "$CACHE_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
