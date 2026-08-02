#!/bin/sh
# Start the analysis worker and the web server in one container.
#
# "One container, one SQLite file" is an identity constraint (IDENTITY.md §1), not a
# packaging convenience, so the worker cannot become a second service. Two processes in
# one container needs supervision, and this is the smallest correct one.
#
# POSIX `sh` ONLY. The runner image is node:24-slim, whose /bin/sh is dash: `wait -n`
# does not exist there ("Illegal option -n", verified in the built image). An earlier
# version of this file used a background subshell doing `wait "$WORKER_PID"`, which
# silently never fired for a second reason — after `exec` replaced the shell, that
# subshell's `wait` referred to a sibling rather than its own child, so a dead worker went
# unnoticed and the container kept serving a queue nothing was consuming. The liveness
# loop below is dull and works in dash.
set -eu

WORKER="/app/apps/worker/dist/start.mjs"
WORKER_ENABLED=false

if [ "${CG_USE_WORKER:-false}" = "true" ]; then
  if [ -f "$WORKER" ]; then
    echo "entrypoint: starting analysis worker" >&2
    node "$WORKER" &
    WORKER_PID=$!
    WORKER_ENABLED=true
  else
    # Refuse rather than degrade. The flag says jobs go to a queue; with no worker binary
    # they would be enqueued and never claimed, and /api/health would keep reporting 200
    # while no index ever completed. Failing at start is the difference between a bad
    # deploy you can see and one you cannot.
    echo "entrypoint: FATAL CG_USE_WORKER=true but $WORKER is missing" >&2
    echo "entrypoint: build it with 'npm run build --workspace @codegraph/worker'" >&2
    exit 1
  fi
else
  # Explicit, because silence is indistinguishable from a worker that started and died.
  echo "entrypoint: worker disabled (CG_USE_WORKER=${CG_USE_WORKER:-false}); analysis runs in-process" >&2
fi

node apps/web/server.js &
WEB_PID=$!

# Forward platform signals to both children instead of letting the shell absorb them.
# Without this every deploy waits out the platform's kill timeout.
trap 'kill -TERM $WEB_PID ${WORKER_PID:-} 2>/dev/null || true' TERM INT

# Whichever child exits first takes the container with it. A web tier without a worker
# accepts jobs nothing will claim; a worker without a web tier serves nobody. Restarting
# is the platform's job — noticing is this script's.
while true; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "entrypoint: web server exited — stopping container" >&2
    break
  fi
  if [ "$WORKER_ENABLED" = "true" ] && ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "entrypoint: worker exited — stopping container so the platform restarts it" >&2
    break
  fi
  sleep 2
done

kill -TERM $WEB_PID ${WORKER_PID:-} 2>/dev/null || true
# Reap, so the container does not exit while a child is still flushing.
wait $WEB_PID 2>/dev/null || true
[ "$WORKER_ENABLED" = "true" ] && { wait "$WORKER_PID" 2>/dev/null || true; }
exit 1
