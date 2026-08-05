#!/usr/bin/env bash
#
# Prove the image builds the way every platform might invoke it — before a platform tells us
# it doesn't.
#
# WHY THIS EXISTS. Four consecutive Render deploys failed, and not one of them was a code
# defect. They were path resolution:
#
#   Root directory "app" does not exist                       (a setting pointing at the
#                                                              pre-monorepo layout)
#   transferring dockerfile: 7.49kB / open Dockerfile: no such file
#   transferring dockerfile: 2B     / open Dockerfile: no such file
#
# Every one of them was reproducible locally in seconds, and none of them was reproducible by
# `docker build .`, which is the only invocation anyone ever runs by hand. That gap is what
# this script closes: it exercises the build the way a PLATFORM does, not the way a developer
# does.
#
# The documented rules it encodes (https://render.com/docs/monorepo-support):
#   · "Files outside your service's root directory are not available to the service at build
#     time or at runtime."  -> this repo's root directory MUST be empty, because the build
#     installs from the ROOT lockfile and traces imports into packages/*.
#   · "Dockerfile path" and "Docker build context directory" are both relative to the root
#     directory -> with an empty root directory they are repo-root-relative.
#
# Usage:
#   scripts/verify-docker.sh            # path resolution (fast, ~20s) + a real build and boot
#   scripts/verify-docker.sh --paths    # path resolution only (no image is built)
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
pass() { printf '%s  ok%s  %s\n' "$GREEN" "$OFF" "$1"; }
fail() { printf '%sFAIL%s  %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }
note() { printf '%s      %s%s\n' "$DIM" "$1" "$OFF"; }

# ---------------------------------------------------------------------------
# 1. One build definition, wherever it is read from.
# ---------------------------------------------------------------------------
# `apps/web/Dockerfile` exists only so a service still configured with the pre-move
# `Dockerfile Path` reads real content instead of the two bytes an absent file produces. A
# COPY can drift and a drifted copy is a deploy built from a Dockerfile nobody edits, so the
# copy is only tolerable while something enforces equality. That is this check, and the
# identical assertion in apps/web/tests/readme-claims.test.ts.
[ -f Dockerfile ] || fail "no Dockerfile at the repo root — BuildKit resolves the build definition from the CONTEXT ROOT, so this file must exist"
if [ -f apps/web/Dockerfile ]; then
  if cmp -s Dockerfile apps/web/Dockerfile; then
    pass "apps/web/Dockerfile is byte-identical to ./Dockerfile"
  else
    fail "apps/web/Dockerfile has DRIFTED from ./Dockerfile — edit ./Dockerfile, then: cp Dockerfile apps/web/Dockerfile"
  fi
else
  note "apps/web/Dockerfile absent — fine once the service's Dockerfile Path reads ./Dockerfile"
fi

# ---------------------------------------------------------------------------
# 2. Every invocation a platform might use must RESOLVE.
# ---------------------------------------------------------------------------
# `--check` runs BuildKit's frontend — it resolves the dockerfile, parses it and lints it —
# without executing a single instruction. That is precisely the half that kept failing, and it
# costs seconds rather than minutes, so it can gate every push.
#
# The context is `.` in all of them because it is the only context this image can build from,
# and that is not a preference: `npm ci` installs from the root lockfile and Next's file tracer
# follows imports into packages/*.
check_resolves() {
  local label="$1"; shift
  if out=$(docker build --check "$@" . 2>&1); then
    pass "$label"
  else
    printf '%s\n' "$out" | tail -5 >&2
    fail "$label"
  fi
}

check_resolves "docker build .                          (platform default)"
check_resolves "docker build -f Dockerfile .            (Dockerfile Path './Dockerfile')" -f Dockerfile
if [ -f apps/web/Dockerfile ]; then
  check_resolves "docker build -f apps/web/Dockerfile .    (pre-move Dockerfile Path)" -f apps/web/Dockerfile
fi

# The shape Render's own logs show: it reads the file at the configured path and hands the
# CONTENT to BuildKit, which then resolves a definition named `Dockerfile`. Piping the bytes in
# is the same thing, and it is how the 7.49kB and 2B transfer figures in those logs were
# matched byte for byte.
if docker build --check -f - . < Dockerfile >/dev/null 2>&1; then
  pass "docker build -f - .  < Dockerfile               (read-then-build-by-name)"
else
  fail "read-then-build-by-name does not resolve"
fi

if [ "${1:-}" = "--paths" ]; then
  note "--paths given: stopping before the real build"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. It has to actually build, and the container has to actually serve.
# ---------------------------------------------------------------------------
# A resolvable Dockerfile that produces a container which 404s on its own health check is not
# a working deploy. The limits are Render Starter's, because a build that only works with more
# memory than production has is not a build that works.
TAG="codegraph-verify:$$"
NAME="codegraph-verify-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker rmi "$TAG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "building ${TAG} (this is the slow part)"
docker build -q -t "$TAG" . >/dev/null || fail "docker build ."
pass "image builds"

docker run -d --name "$NAME" --memory=512m --memory-swap=512m --cpus=0.5 -p 4599:4000 "$TAG" >/dev/null \
  || fail "container did not start"

for _ in $(seq 1 40); do
  if curl -fsS -m 3 http://127.0.0.1:4599/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS -m 5 http://127.0.0.1:4599/api/health | grep -q '"status":"ok"' \
  || { docker logs "$NAME" 2>&1 | tail -20 >&2; fail "/api/health did not report ok under 512MB/0.5cpu"; }
pass "/api/health reports ok under --memory=512m --cpus=0.5"

# The worker is what claims queued jobs. With CG_USE_WORKER=true baked into the image and no
# worker running, every index would sit in the queue forever while the app looked healthy —
# the failure mode the entrypoint refuses to boot into, asserted here too.
docker logs "$NAME" 2>&1 | grep -q "worker started" \
  || { docker logs "$NAME" 2>&1 | tail -20 >&2; fail "the analysis worker did not start"; }
pass "analysis worker started"

printf '\n%sall docker paths resolve and the image serves%s\n' "$GREEN" "$OFF"
