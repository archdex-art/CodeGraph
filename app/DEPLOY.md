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
- Runs as **root** — deliberately; see `docs/postmortems/2026-07-10-render-crash-loop.md`. A platform-mounted persistent disk (Render) doesn't inherit the image's baked-in ownership and can reset to root on every restart; dropping privileges after fixing ownership (`setpriv`) crash-looped because Render doesn't grant `CAP_SETUID`. Running as root sidesteps the whole class of problem.
- SQLite persists to the named volume `codegraph-data` (`/app/data`).
- `HEALTHCHECK` polls `/api/health`.

## Configuration (env)
| Var | Where | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | website build + GitHub OAuth callback | `https://app.codegraph.dev` | Marketing "Start Indexing" target; also the base URL used to build the OAuth `redirect_uri` (falls back to the request's own origin if unset) |
| `PORT` | app runtime | `4000` | HTTP port |
| `HOSTNAME` | app runtime | `0.0.0.0` | Bind address (Docker) |
| `CG_MAX_FILES` | app runtime | `4000` | Max files scanned per repo |
| `CG_CLONE_TIMEOUT_MS` | app runtime | `90000` | git clone timeout |
| `CG_DATA_DIR` | app runtime | `./data` | SQLite location |
| `CG_ALLOW_LOCAL_ACCESS` | app runtime | unset (= off in production) | Opt in to local-folder indexing + server-side folder browsing on a public deployment. Only set `true` on a trusted, single-operator host. |
| `CG_BASIC_AUTH_PASSWORD` | app runtime | unset (= off) | Gate the whole app behind HTTP Basic Auth. Pairs with `CG_BASIC_AUTH_USER` (default `codegraph`). |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | app runtime | unset (= GitHub sign-in hidden) | From a GitHub OAuth App — see below. |
| `CG_SESSION_SECRET` | app runtime | unset (= GitHub sign-in disabled) | Encrypts the GitHub session cookie (AES-256-GCM). Required alongside the two vars above for GitHub sign-in to activate. Any long random string; rotating it signs everyone out. |

## GitHub sign-in setup (optional)
Lets a signed-in user browse and one-click import their own repos — including private ones — instead of pasting a URL. Fully optional and off by default; skip this section if you don't need it.

1. **Register a GitHub OAuth App**: GitHub → Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers) → **New OAuth App**.
   - **Homepage URL**: your deployment's public URL (e.g. `https://codegraph-8qqc.onrender.com`).
   - **Authorization callback URL**: that same URL + `/api/auth/github/callback` (e.g. `https://codegraph-8qqc.onrender.com/api/auth/github/callback`) — must match exactly, including scheme.
   - For local dev too, either register a second OAuth App with callback `http://localhost:4000/api/auth/github/callback`, or just reuse one app and update its callback URL when switching between local and deployed testing.
2. Copy the **Client ID**, and generate + copy a **Client Secret**.
3. Set three env vars on the deployment (and/or in a local `.env.local` for dev):
   ```bash
   GITHUB_OAUTH_CLIENT_ID=<from step 2>
   GITHUB_OAUTH_CLIENT_SECRET=<from step 2>
   CG_SESSION_SECRET=<any long random string, e.g. `openssl rand -hex 32`>
   NEXT_PUBLIC_APP_URL=<your deployment's public URL, no trailing slash>
   ```
4. Restart/redeploy. A "Sign in with GitHub" link appears in the header and a "My GitHub" tab appears on the Start Indexing page automatically once all three of `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` / `CG_SESSION_SECRET` are set — no other config needed, and nothing changes for anyone if you leave them unset.

**What this grants**: the OAuth scope requested is `repo read:user` — GitHub's classic OAuth has no finer-grained read-only scope, so this is full read/write access to the signed-in user's repos (needed to clone private ones at all) plus their public profile. The token is held only in an encrypted, `httpOnly` session cookie — never written to disk, never returned in any API response, and only ever sent back to `github.com` itself (see `lib/session.ts` and the `runJob` host check in `lib/store.ts`).

## Health & observability
- `GET /api/health` → `{ status: "ok", uptime, ts }` (200). Use for LB/Docker/K8s probes.
- Jobs are persisted in SQLite; a crashed indexing job is retriable by re-submitting.
- Indexing runs in-process (fire-and-forget). For high throughput, front with a queue (future work).

## Security notes
- Anonymous git URLs must be public; `GIT_TERMINAL_PROMPT=0` prevents credential prompts. A signed-in GitHub user (see above) can additionally clone their own private repos, authenticated with their own OAuth token — never anyone else's.
- Repo URL is validated (`^https?://…`) and SSRF-guarded (rejects loopback/private/link-local hosts, see `lib/urlSafety.ts`) before use; clone runs with a timeout + output cap.
- Local-folder indexing is **off by default on a public deployment** (`CG_ALLOW_LOCAL_ACCESS`) — self-hosted/trusted-host use only; never turn it on for untrusted visitors on a shared host.
- No secrets are required for the core product — the agent swarm is deterministic and needs **no LLM API key**. GitHub sign-in is the one optional feature that needs secrets (see above); everything else runs with zero credentials.

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

## Built-in editor workspaces
- Indexing a **git** repo now clones it into `data/workspaces/<repoId>/` (depth 50, all branches) instead of a disposable temp dir, so the Editor tab has a live working tree to read/write/commit against. This lives on the same persistent disk as the SQLite DB — bump `disk.sizeGB` in `render.yaml` (or the `codegraph-data` volume) if you index many/large repositories.
- Deleting a git-sourced repo removes its `workspaces/<repoId>` directory. Deleting a **local**-sourced repo never touches disk — its "workspace" is the user's real folder passed in at index time.
- The remediation executor (`/api/repos/:id/fix`) is unaffected: it still clones into a disposable `os.tmpdir()` sandbox and removes it when done.