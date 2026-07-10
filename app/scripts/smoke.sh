#!/usr/bin/env bash
# Post-deploy smoke test: hits a running CodeGraph instance and confirms
# indexing actually works end-to-end, not just that the process is up.
# A passing /api/health check alone would NOT have caught any of the three
# incidents fixed in this repo's history (disk-permission crash, tree-sitter
# init hang, WASM OOM) — all three left health checks green while indexing
# was completely broken. This exercises the real path.
#
# Usage:
#   ./scripts/smoke.sh [BASE_URL]
#   BASE_URL defaults to http://localhost:4000
#
# Exit code 0 = healthy, non-zero = something's wrong (see stderr).
set -euo pipefail

BASE_URL="${1:-http://localhost:4000}"
REPO_URL="https://github.com/octocat/Hello-World"
TIMEOUT_S=60
POLL_INTERVAL_S=2

log() { echo "[smoke] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

log "target: $BASE_URL"

# 1. Health check
HEALTH=$(curl -sf --max-time 10 "$BASE_URL/api/health") || fail "health check unreachable"
echo "$HEALTH" | grep -q '"status":"ok"' || fail "health check did not report ok: $HEALTH"
log "health check ok"

# 2. Start a real index job
START=$(curl -sf --max-time 15 -X POST "$BASE_URL/api/index" \
  -H "Content-Type: application/json" \
  -d "{\"repoUrl\":\"$REPO_URL\"}") || fail "POST /api/index failed"
JOB_ID=$(echo "$START" | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])" 2>/dev/null) \
  || fail "unexpected /api/index response: $START"
log "started job $JOB_ID"

# 3. Poll until done/error/timeout — this is the part that silently hung or
#    OOM-killed the whole server in the incidents this script guards against.
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT_S" ]; do
  STATUS_JSON=$(curl -sf --max-time 10 "$BASE_URL/api/jobs/$JOB_ID") || fail "lost contact with server mid-index (it may have crashed)"
  STATUS=$(echo "$STATUS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

  if [ "$STATUS" = "done" ]; then
    log "indexing completed: $STATUS_JSON"
    HEALTH_AFTER=$(curl -sf --max-time 10 "$BASE_URL/api/health") || fail "server unreachable immediately after a successful index (residual crash?)"
    echo "$HEALTH_AFTER" | grep -q '"status":"ok"' || fail "server unhealthy after indexing: $HEALTH_AFTER"
    log "server still healthy post-index"
    log "SMOKE TEST PASSED"
    exit 0
  fi
  if [ "$STATUS" = "error" ]; then
    fail "indexing reported an error: $STATUS_JSON"
  fi

  sleep "$POLL_INTERVAL_S"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_S))
done

fail "indexing did not complete within ${TIMEOUT_S}s (hung, matching the tree-sitter-init incident)"
