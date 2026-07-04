# CodeGraph — Deployment & Operations

Production runbook for the CodeGraph product app.

## Requirements
- **Node ≥ 22** (uses the built-in `node:sqlite` — no native modules).
- **git** on PATH at runtime (clones public repos).
- Writable `./data` directory (SQLite + WAL).

## Run modes

### Local dev
```bash
cd CodeGraph/app
npm install
npm run dev          # http://localhost:4000
```

### Production (standalone Node)
```bash
npm run build        # emits .next/standalone/server.js (output: "standalone")
npm run start        # next start -p 4000
```

### Docker (recommended)
```bash
cd CodeGraph/app
docker compose up --build          # http://localhost:4000
```
- Multi-stage build on `node:24-slim`; runtime image includes `git`.
- Runs as non-root (`node` user).
- SQLite persists to the named volume `codegraph-data` (`/app/data`).
- `HEALTHCHECK` polls `/api/health`.

## Configuration (env)
| Var | Where | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | website build | `https://app.codegraph.dev` | Marketing "Start Indexing" target |
| `PORT` | app runtime | `4000` | HTTP port |
| `HOSTNAME` | app runtime | `0.0.0.0` | Bind address (Docker) |
| `CG_MAX_FILES` | app runtime | `4000` | Max files scanned per repo |
| `CG_CLONE_TIMEOUT_MS` | app runtime | `90000` | git clone timeout |
| `CG_DATA_DIR` | app runtime | `./data` | SQLite location |

## Health & observability
- `GET /api/health` → `{ status: "ok", uptime, ts }` (200). Use for LB/Docker/K8s probes.
- Jobs are persisted in SQLite; a crashed indexing job is retriable by re-submitting.
- Indexing runs in-process (fire-and-forget). For high throughput, front with a queue (future work).

## Security notes
- Only **public** git URLs are cloned; `GIT_TERMINAL_PROMPT=0` prevents credential prompts.
- Repo URL is validated (`^https?://…`) before use; clone runs with a timeout + output cap.
- Local-folder indexing is **self-hosted only** — never expose the local-path API to untrusted users on a shared host.
- No secrets are required to run. The agent swarm is deterministic and needs **no LLM API key**.

## Scaling path (documented, not yet implemented)
1. Move indexing to a worker queue (Redis/BullMQ) — API stays; `store.createIndexJob` enqueues.
2. Swap SQLite → Postgres (`pgvector`) via the same `store` interface for multi-tenant scale + real embeddings.
3. Incremental re-index on webhooks (only changed files re-parsed).

## CI checklist
```bash
npm run test         # vitest unit tests (engines)
npm run build        # typecheck + standalone build
```

## Backup / restore
- State is a single file: `data/codegraph.sqlite` (+ `-wal`, `-shm`). Back up the `data` volume.
- Restore by placing the file back and restarting.
