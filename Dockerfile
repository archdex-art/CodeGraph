# THE IMAGE FOR apps/web, BUILT FROM THE MONOREPO ROOT.
#
# NO `# syntax=` DIRECTIVE, DELIBERATELY, AND IT MUST NOT COME BACK WITHOUT READING THIS.
#
# That directive tells BuildKit to fetch an EXTERNAL frontend image and hand the build to it,
# and that frontend resolves the Dockerfile ITSELF rather than using the definition BuildKit
# already loaded. On Render that second resolution is what failed, every time, for five
# deploys — the logs show step #1 succeeding and then the solve dying:
#
#   #1 [internal] load build definition from Dockerfile
#   #1 transferring dockerfile: 9.55kB done          <- this file, read correctly
#   #1 DONE 0.0s
#   error: failed to solve: failed to read dockerfile: open Dockerfile : no such file or directory
#
# The same invocation locally (`docker build -f apps/web/Dockerfile .`) prints the identical
# step name and the identical 9.55kB and then BUILDS, because the local builder resolves the
# frontend differently. That divergence is the whole bug, and it is not reachable from the
# Dockerfile's own content — only from whether an external frontend is involved at all.
#
# The directive bought this file NOTHING: it uses no BuildKit-frontend feature — no
# `RUN --mount`, no heredocs, no `COPY --link`, no `COPY --chmod`. Checked before removing it,
# and `scripts/verify-docker.sh` re-checks every path that can invoke this build.
#   docker build -t codegraph .
#
# It lives HERE, beside the lockfile, rather than in apps/web, because the repo root is the
# only context it can be built from: `npm ci` installs from the root lockfile and Next's file
# tracer follows imports into packages/*, both of which are outside apps/web. A build
# definition whose context must be the root belongs at the root.
#
# WHY IT IS HERE AND NOT IN apps/web, in one line: the dockerfile must sit at the TOP OF ITS
# OWN CONTEXT. That is not a preference, it is the invariant the deploy has always needed and
# the one the monorepo move quietly broke:
#
#   916e894 (deployed fine)  dockerfilePath ./app/Dockerfile      dockerContext ./app   ✓ top
#   1d62a62 (P1 move)        dockerfilePath ./apps/web/Dockerfile dockerContext .       ✗ not
#   here                     dockerfilePath ./Dockerfile          dockerContext .       ✓ top
#
# With the file one directory INSIDE the context, Render's build read it (the log's
# `transferring dockerfile: 7.49kB` is this file's exact size at the time) and then asked
# BuildKit for a dockerfile called `Dockerfile` at the context root, which was not there:
#
#   failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory
#
# reproduced locally, byte-identical, as `docker build -f Dockerfile .`.
#
# `apps/web/Dockerfile` IS A BYTE-IDENTICAL COPY OF THIS FILE, and only for one reason: a
# service still configured with the old `Dockerfile Path` must read real content instead of
# the two bytes an absent file produces (`transferring dockerfile: 2B`, the second failure).
#
# A symlink was tried first and rejected on evidence: BuildKit will not build THROUGH one
# (`-f apps/web/Dockerfile` -> `failed to read dockerfile: too many links`). It satisfied the
# read but broke an invocation that only a theory said was unused, and a theory is not what
# this has earned. A copy works whichever lookup the platform performs.
#
# The copy's one hazard is drift, so it is not left to discipline: readme-claims.test.ts fails
# the build if the two files differ. EDIT THIS FILE, then `cp Dockerfile apps/web/Dockerfile`.
# Delete the copy and that test once the service's Dockerfile Path reads `./Dockerfile` and a
# deploy has proven it.

# ---------- Stage 1: builder ----------
FROM node:24-slim AS builder
WORKDIR /repo

# Install against the ROOT lockfile so the whole workspace resolves in one
# pass. `npm ci` is not merely preferred here, it is required: a cold
# `npm install` at the workspace root does full metadata resolution for ~500
# packages and did not finish in several minutes during the P1 spike
# (docs/design/SPIKES.md §1), whereas `npm ci` against the committed lockfile
# takes ~23s. If the build ever appears to hang at install, this is why.
#
# Manifests are copied before sources so a source-only change reuses the
# install layer.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
RUN npm ci

# Now the sources. `.dockerignore` at the repo root keeps node_modules, .next
# and the runtime data dir out.
COPY . .

# Ensure public/ exists so the runner-stage COPY always has a source, even when
# the repo ships no static assets.
RUN mkdir -p apps/web/public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @codegraph/web

# The worker is compiled here, in the stage that still has devDependencies. It cannot
# run from source in the runner: packages publish raw TypeScript (LLD §1.1) and `tsx` is
# a devDependency absent from the traced standalone tree. Two bundles come out —
# dist/start.mjs (the supervisor, ~130 KB) and dist/execute.mjs (the per-job executor,
# ~15 MB with the pipeline inlined). The size gap is itself a check: if start.mjs is tens
# of megabytes, something imported the analysis pipeline into the long-lived process,
# which is what `supervisor-loads-no-parser` forbids.
RUN npm run build --workspace @codegraph/worker

# ---------- Stage 2: runner ----------
FROM node:24-slim AS runner
WORKDIR /app

# git is required at runtime to clone public repos; ca-certificates for https.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000 \
    HOSTNAME=0.0.0.0

# MUST be absolute, and MUST match the disk mountPath in render.yaml.
#
# Not optional, and not merely tidy. `config.dataDir` defaults to
# `path.join(process.cwd(), "data")`, and Next's standalone server chdirs to the
# directory holding server.js. Before the monorepo move that was /app, so the
# default landed on /app/data — exactly where the persistent disk mounts. After
# the move it is /app/apps/web, so the default silently became
# /app/apps/web/data: a container-ephemeral path.
#
# The failure mode is nasty precisely because nothing looks wrong. Health checks
# pass, indexing works, scores appear — and then every deploy or restart discards
# every indexed repo, editor workspace and saved setting, because the writes
# never touched the mounted volume. Verified by inspecting /proc/1/cwd and
# finding the live SQLite file under /app/apps/web/data while /app/data sat
# empty. The Docker smoke test now asserts the database is on this path.
ENV CG_DATA_DIR=/app/data

# Standalone output is NESTED under the workspace path, because
# `outputFileTracingRoot` must be the monorepo root for the tracer to follow
# imports into packages/* (apps/web/next.config.ts explains the trade).
#
#   single app/  →  .next/standalone/server.js
#   monorepo     →  .next/standalone/apps/web/server.js
#
# The standalone tree is copied VERBATIM, preserving that nesting, and the CMD
# points at the nested entrypoint. Do not "tidy" this by flattening the inner
# apps/web directory up to /app to keep the old `CMD ["node","server.js"]`:
# that was tried during P1 and it builds a perfectly healthy-looking image
# whose /api/health returns 200 while every route that touches the TypeScript
# compiler dies with
#
#   Error: Failed to load external module typescript-<hash>:
#   Cannot find module 'typescript-<hash>'
#
# Turbopack resolves server-external packages through a path baked at build
# time, relative to where it emitted server.js. Next puts the traced
# `node_modules` at the standalone ROOT — two levels above the nested
# server.js — and flattening collapses that distance, so the baked reference
# no longer lands on node_modules. The failure is invisible to a health check
# and only shows up on POST /api/index.
#
# This whole block fails at CONTAINER START, not at build. A CI build stays
# green while production crash-loops, which is why the Docker smoke test is a
# required gate for this phase (docs/design/SPIKES.md §1) and why that test
# must exercise a real index, not just /api/health.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

# Compiled worker + the entrypoint that runs it beside the web server. Both are inert
# unless CG_USE_WORKER=true, so this copy is safe to ship ahead of the flag flip.
COPY --from=builder /repo/apps/worker/dist ./apps/worker/dist
COPY apps/web/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Runtime SQLite DB + WAL live here. Runs as root (see below) specifically
# so this never depends on file ownership: a platform-attached persistent
# disk (e.g. Render) mounts fresh over this path on every start and may
# reset ownership to root, and privilege-dropping tools (setpriv/gosu) can
# fail outright under a capability-restricted container sandbox (verified:
# setpriv errors with "setresuid failed: Operation not permitted" when
# CAP_SETUID/CAP_SETGID aren't granted) — silently crash-looping the whole
# app. Root sidesteps both failure modes; it can read/write regardless of
# the mount's ownership.
# The image always ships the compiled worker, so the image is where the flag flips.
# Left FALSE in `packages/config` so `npm run dev` keeps running analysis inline —
# `next dev` starts no worker, and a developer should not have to run two processes to
# index a repo. A developer who wants the real path runs
# `npm run start --workspace @codegraph/worker` alongside it.
#
# Proven before flipping, at the constraint that matters: two concurrent index jobs in
# this image at --memory=512m --cpus=0.5 both reached `done`, peak RSS 341.8 MiB of 512,
# no OOM kill and no restart. That is ADR-001 measured rather than asserted.
ENV CG_USE_WORKER=true

RUN mkdir -p /app/data

EXPOSE 4000

# Lightweight health probe against the app's own health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

# Nested per the standalone layout above. `render.yaml` has no start command of
# its own, so this is the single place the entrypoint path is declared.
#
# The entrypoint starts the worker first when CG_USE_WORKER=true, then `exec`s the web
# server so it becomes PID 1 and receives SIGTERM directly. With the flag off it only
# logs and execs, so this is behaviour-identical to the previous
# `CMD ["node", "apps/web/server.js"]` until the flag is set.
CMD ["/app/entrypoint.sh"]
