#!/bin/sh
# Runs as root (the image's default runtime user — see Dockerfile). Platforms
# that attach a persistent disk at /app/data (e.g. Render) mount it fresh at
# container start, which resets ownership to root regardless of the `chown`
# baked into the image at build time. Fix ownership here, every start, before
# dropping to the unprivileged `node` user to run the actual app — otherwise
# SQLite (and git-clone workspaces, and trash) can't write to /app/data and
# every indexing job fails silently on the very first DB write.
set -e
mkdir -p /app/data
chown -R node:node /app/data
exec setpriv --reuid=node --regid=node --init-groups "$@"
