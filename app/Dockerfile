# syntax=docker/dockerfile:1

# ---------- Stage 1: builder ----------
FROM node:24-slim AS builder
WORKDIR /app

# Install deps against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Build the Next.js app (emits .next/standalone via output: "standalone").
# Ensure public/ exists so the runner-stage COPY always has a source, even
# when the repo ships no static assets.
COPY . .
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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

# Copy the standalone server bundle and static assets per Next conventions.
# The standalone output already includes a minimal node_modules and server.js.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Runtime SQLite DB + WAL live here. Runs as root (see below) specifically
# so this never depends on file ownership: a platform-attached persistent
# disk (e.g. Render) mounts fresh over this path on every start and may
# reset ownership to root, and privilege-dropping tools (setpriv/gosu) can
# fail outright under a capability-restricted container sandbox (verified:
# setpriv errors with "setresuid failed: Operation not permitted" when
# CAP_SETUID/CAP_SETGID aren't granted) — silently crash-looping the whole
# app. Root sidesteps both failure modes; it can read/write regardless of
# the mount's ownership.
RUN mkdir -p /app/data

EXPOSE 4000

# Lightweight health probe against the app's own health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
