# Postmortem: Indexing failed with "unable to open database file"

**Date:** 2026-07-10 · **Severity:** Critical (100% of indexing requests failed) · **Fixed in:** `2dd8618`

## Summary
Every indexing request on the Render deployment failed immediately with `{"error":"unable to open database file"}`. The app itself was reachable and `/api/health` returned 200 — only anything touching SQLite failed.

## Impact
- 100% of `POST /api/index` requests failed on the live deployment.
- No data loss (nothing had ever been written).
- Health checks and static pages were unaffected, so the outage wasn't obvious from uptime monitoring alone.

## Root Cause
The Dockerfile ran the app as a non-root `node` user (`USER node`), with `RUN mkdir -p /app/data && chown -R node:node /app` baked in at build time. Render mounts the `codegraph-data` persistent disk fresh over `/app/data` on every container start — a real block-storage mount, not a Docker named volume — and that mount comes up owned by `root`, independent of whatever the image's build-time `chown` set. The non-root `node` user then had no write access to `/app/data`, so `node:sqlite`'s `DatabaseSync` constructor threw on the very first request that touched the DB.

**Why this wasn't caught locally:** local Docker named volumes have a "copy content from the image into the new volume" behavior on first use, which silently pre-seeds the volume with the image's already-correctly-owned `/app/data` directory. Render's real block-storage disk mount doesn't do this — it's genuinely empty and root-owned. The two are not equivalent for testing this class of bug.

## Detection
User report ("repos are not getting indexed") — no automated signal caught this. `/api/health` doesn't touch the database, so it stayed green throughout.

## Resolution
Added `docker-entrypoint.sh`: start the container as root, `chown -R node:node /app/data` at every boot (not just build time), then drop to the `node` user via `setpriv` before exec'ing the server. Verified by reproducing the exact failure locally: `docker run --tmpfs /app/data:uid=0,gid=0,mode=0755 ...` (forces a root-owned fresh mount, matching Render's behavior) reliably reproduced `unable to open database file`; the fix resolved it under the identical adversarial condition.

*(This fix was itself superseded two incidents later — see `2026-07-10-render-crash-loop.md` — because `setpriv` turned out to be unsupported in Render's actual sandbox. Documented here for the historical record; the current fix is "run as root the whole time," not this entrypoint script.)*

## Prevention / Action Items
- [x] `scripts/smoke.sh` now exercises a real indexing job end-to-end post-deploy, not just `/api/health` — this class of bug fails loudly on the first smoke-test run instead of waiting for a user report.
- [x] CI's Docker smoke-test job runs under `--tmpfs /app/data:uid=0,gid=0` specifically to keep reproducing this exact failure mode on every push.
