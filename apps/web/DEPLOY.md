# CodeGraph — Deployment & Operations

Production runbook for the CodeGraph product app.

## Requirements
- **Node ≥ 22** (uses the built-in `node:sqlite` — no native modules).
- **git** on PATH at runtime (clones public repos).
- Writable `./data` directory (SQLite + WAL).

## Run modes

### Local dev
```bash
cd CodeGraph            # repo root — this is an npm workspace
npm ci                  # never `npm install` at the root (see CLAUDE.md §4)
npm run dev             # http://localhost:4000
```

### Production (standalone Node)
```bash
npm run build           # emits apps/web/.next/standalone/apps/web/server.js
npm run start           # next start -p 4000
```

The standalone entrypoint is nested under `apps/web/` because
`outputFileTracingRoot` points at the monorepo root so the tracer follows
imports into `packages/*`. Run it with `node apps/web/server.js` from inside
the copied standalone directory — and do not flatten that layout to shorten
the path (REVIEW_2026-07-29 P1-5 explains the runtime failure that causes).

### Docker (recommended)
```bash
cd CodeGraph                       # the build context IS the repo root
docker build -t codegraph .        # no -f: the Dockerfile is at the top of its context
docker compose up --build          # http://localhost:4000
npm run docker:verify              # build it the way a PLATFORM will, and boot it
```
- Multi-stage build on `node:24-slim`; runtime image includes `git`.
- Runs as **root** — deliberately; see `docs/postmortems/2026-07-10-render-crash-loop.md`. A platform-mounted persistent disk (Render) doesn't inherit the image's baked-in ownership and can reset to root on every restart; dropping privileges after fixing ownership (`setpriv`) crash-looped because Render doesn't grant `CAP_SETUID`. Running as root sidesteps the whole class of problem.
- SQLite persists to the named volume `codegraph-data` (`/app/data`).
- `HEALTHCHECK` polls `/api/health`.

#### Where the Dockerfile lives, and why that is not cosmetic

**`./Dockerfile` — the repo root. Not `apps/web/`.** The image can only be built from one
context, the repo root, because `npm ci` installs from the **root** lockfile and Next's file
tracer follows imports into `packages/*`. A build definition whose context must be the root
belongs at the root, so that a platform's *dockerfile path* and *build context* name the same
directory and cannot disagree.

That invariant — **the Dockerfile sits at the top of its own context** — is what the original
deploy had (`dockerfilePath: ./app/Dockerfile` with `dockerContext: ./app`) and what the
monorepo move silently broke by keeping the path at `apps/web/Dockerfile` while widening the
context to the root. Four consecutive production deploys failed on it, none for a code reason:

| symptom in the deploy log | cause |
|---|---|
| `Root directory "app" does not exist` | a service setting still naming the pre-monorepo layout |
| `transferring dockerfile: 7.49kB` then `open Dockerfile: no such file` | the definition was read from `apps/web/`, then resolved by bare name at the context root |
| `transferring dockerfile: 2B` then the same error | the configured path no longer existed — `2B` is what BuildKit sends when it finds no dockerfile at all |

`apps/web/Dockerfile` is a **byte-identical copy**, and a temporary one: it exists only so a
service still configured with the pre-move path reads real content. Its drift hazard is
enforced away by `scripts/verify-docker.sh` and by `apps/web/tests/readme-claims.test.ts`, both
of which fail if the two files differ. **Edit `./Dockerfile`, then `cp Dockerfile apps/web/Dockerfile`.**
Delete the copy, that test, and this paragraph once the service's *Dockerfile Path* reads
`./Dockerfile` and a deploy has proven it.

#### Render service settings (the fields, exactly)

Two rules from Render's own documentation ([monorepo support](https://render.com/docs/monorepo-support))
decide all of these:

> *"Files outside your service's root directory are not available to the service at build time or at runtime."*
> *"Root-relative settings … Dockerfile path, Docker build context directory."*

So the **Root Directory must be empty**: set it to `apps/web` and the root lockfile and
`packages/*` stop existing as far as the build is concerned. And because the other two fields
are relative to it, an empty root directory makes them repo-root-relative:

| Dashboard field (Settings → Build & Deploy) | Required value | Live service, 2026-08-05 |
|---|---|---|
| Root Directory | *empty* — not `.`, not `apps/web` | *empty* ✅ |
| Dockerfile Path | `./Dockerfile` | `./apps/web/Dockerfile` ⚠️ works only because of the byte-identical copy above |
| Docker Build Context Directory | `.` | `.` ✅ |
| Docker Command | *empty* — the image's `CMD` starts the worker and then `exec`s the web server; anything here replaces it and jobs queue forever | *empty* ✅ |
| Auto-Deploy | your call | **Off** — merging to `main` deploys nothing until you click **Manual Deploy** |

Set *Dockerfile Path* to `./Dockerfile` and the copy at `apps/web/Dockerfile` can be deleted
along with its test; until then it is the only thing making that setting survivable.

`render.yaml` declares the same values. It is only authoritative for a **Blueprint-managed**
service: the deploy log says `It looks like we don't have access to your repo`, so for this
service the dashboard is the source of truth and the table above must be entered by hand. A
Blueprint sync does **not** clear a value typed into the dashboard of an existing service.

#### ⚠️ The live service is on Free, and Free has no disk

Instance type is **Free · 0.1 CPU · 512 MB**, and Free instances cannot have a persistent
disk. `CG_DATA_DIR=/app/data` is therefore a directory *inside the container*, and everything
the product persists lives there:

- `codegraph.sqlite` + WAL — every indexed repository's score, issues, graph and run history
- `data/workspaces/<repoId>` — a full git clone per indexed repo, and the editor's working tree
- `data/trash`, `data/index-cache` — restorable deletions and the incremental-index manifests

All of it is destroyed on **every deploy, every restart, and every idle spin-down** — a Free
instance stops after roughly 15 minutes without traffic. Sign-in sessions go with it. The app
does not fail, it forgets, which is the harder failure to notice.

Upgrading the instance type to **Starter** is what fixes it; `render.yaml`'s runtime section
carries the exact `plan`/`numInstances`/`disk` block to add, and `mountPath` must equal the
Dockerfile's `ENV CG_DATA_DIR` or the writes miss the volume and the symptom is identical to
having no disk at all.

The other Free-tier consequence is speed: 0.1 CPU against the 0.5 the smoke tests use. The
512 MB ceiling — the one that governs OOM — is the same, so the memory verification still
holds; indexing simply takes proportionally longer, and the worker's shutdown drain is why
`maxShutdownDelaySeconds` is raised.

#### Deploying the prebuilt image (the way that cannot break on paths)

Every deploy failure this project has had was a **build-input** problem on the platform, not a
code problem: a stale Root Directory, a Dockerfile Path pointing at a moved file, and an
external BuildKit frontend that could not re-resolve the Dockerfile. None of them was
reproducible by `docker build .`, and **none of them can happen if the platform is not
building.**

`.github/workflows/publish-image.yml` builds the image on every push to `main` — in the same
CI that already indexes two real repositories with it and gates peak memory at 85% of the
512 MB budget — and pushes it to GHCR:

```
ghcr.io/archdex-art/codegraph:latest
ghcr.io/archdex-art/codegraph:<commit-sha>
```

A service that PULLS that image has no Dockerfile path, no build context, no root directory
and no frontend. The image running in production is bit-for-bit the one CI verified, which is
not true today — Render currently rebuilds from source and can produce a different image from
the one that passed.

**One-time setup:**

1. Push to `main` once so the workflow publishes the first image.
2. GitHub → the repo → *Packages* → `codegraph` → *Package settings* → **change visibility to
   Public**. Packages pushed with `GITHUB_TOKEN` are private by default even in a public repo,
   and a private image needs a Render *Registry Credential* instead.
3. Render → *New* → *Web Service* → **Existing Image** → image URL
   `ghcr.io/archdex-art/codegraph:latest`.
4. Set the environment variables from the table below, the health check path `/api/health`,
   and — if you want persistence — a Starter instance with a disk at `/app/data`.
5. Delete the old repo-backed service once the new one serves traffic.

Deploy by clicking *Manual Deploy* (or hitting the Deploy Hook from CI) after a publish. Pin
the SHA tag rather than `latest` when you need certainty about which image is running: Render
caches mutable tags, so `latest` can serve a stale image.

The Dockerfile-based path stays fully supported and is what `docker compose` and CI use; this
is about which of the two the *production service* depends on.

#### Before you push a Docker change

```bash
npm run docker:paths     # ~5s: every path a platform might resolve, via `docker build --check`
npm run docker:verify    # ~20s: the above, plus a real build and a boot under 512MB/0.5cpu
```

CI runs `docker:paths` ahead of the image build for the same reason: every one of those four
failures was reproducible locally in seconds, and none of them was reproducible by
`docker build .`, which is the only invocation anyone runs by hand.

## Configuration (env)
| Var | Where | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | website build + GitHub OAuth callback | `https://app.codegraph.dev` | Marketing "Start Indexing" target; also the base URL used to build the OAuth `redirect_uri` (falls back to the request's own origin if unset) |
| `PORT` | app runtime | `4000` | HTTP port |
| `HOSTNAME` | app runtime | `0.0.0.0` | Bind address (Docker) |
| `CG_MAX_FILES` | app runtime | `4000` | Max files scanned per repo. Reaching it truncates the walk, and the report then says so — the Health Score is labelled a sample rather than presented as the repository's score. `microsoft/TypeScript` holds 39,334 analysable files, so raise this if you want a whole-repository score for a codebase that size. |
| `CG_MAX_FILE_BYTES` | app runtime | `400000` | Per-file size ceiling; anything larger is counted in the coverage report as "over the size cap" and never read. Guards against minified bundles and vendored blobs. |
| `CG_CLONE_TIMEOUT_MS` | app runtime | `90000` | git clone timeout |
| `CG_DATA_DIR` | app runtime | `./data` | SQLite location |
| `CG_ALLOW_LOCAL_ACCESS` | app runtime | unset (= off in production) | Opt in to local-folder indexing + server-side folder browsing on a public deployment. Only set `true` on a trusted, single-operator host. |
| `CG_BASIC_AUTH_PASSWORD` | app runtime | unset (= off) | Gate the whole app behind HTTP Basic Auth. Pairs with `CG_BASIC_AUTH_USER` (default `codegraph`). |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | app runtime | unset (= GitHub sign-in hidden) | From a GitHub OAuth App — see below. |
| `CG_SESSION_SECRET` | app runtime | unset (= GitHub sign-in disabled) | Encrypts the GitHub session cookie (AES-256-GCM). Required alongside the two vars above for GitHub sign-in to activate. Any long random string; rotating it signs everyone out. |
| `CG_OWNER_GITHUB_LOGIN` | app runtime | unset (= no owner-lock) | Restrict the **entire app** — every page and API route, including the normally-anonymous public bucket — to one or more GitHub logins (comma-separated, case-insensitive). Requires GitHub sign-in to be fully configured too (fails closed with a 500 otherwise). See below. |
| `ANTHROPIC_API_KEY` | app runtime | unset (= Claude AI Assistant hidden) | Enables the Editor tab's AI Assistant using Claude (Claude Agent SDK) — see below. Core product features never need this. |
| `CLAUDE_CODE_OAUTH_TOKEN` | app runtime | unset | Alternative to `ANTHROPIC_API_KEY`: authenticates Claude via a Pro/Max/Team subscription login instead of pay-per-token API billing. The only way subscription mode can work on a hosted/container deployment (no persistent home directory, no interactive terminal for `claude login`) — see below. |
| `CG_LOCAL_LLM_BASE_URL` | app runtime | unset (= local-model AI Assistant hidden) | Base URL of an OpenAI-compatible chat-completions endpoint (Ollama, LM Studio, llama.cpp `server`, vLLM, …), e.g. `http://localhost:11434/v1`. Required alongside `CG_LOCAL_LLM_MODEL` — see below. |
| `CG_LOCAL_LLM_MODEL` | app runtime | unset | Model name/tag to request from that endpoint, e.g. `qwen2.5-coder:7b`. Required alongside `CG_LOCAL_LLM_BASE_URL`. |
| `CG_LOCAL_LLM_API_KEY` | app runtime | unset (sends `local`) | Optional bearer token if your local server's endpoint requires one; most (Ollama, LM Studio) don't. |
| `CG_LOCAL_ACCESS_ROOT` | app runtime | unset (= unrestricted once `CG_ALLOW_LOCAL_ACCESS` is on) | Defense-in-depth: when set, confines `/api/browse` and local-folder indexing to descendants of this directory even if `CG_ALLOW_LOCAL_ACCESS=true`, so a local-access misconfiguration can't expose the whole filesystem. |
| `CG_FORCE_SECURE_COOKIES` | app runtime | unset (= derived from the request) | Override the session/OAuth cookies' `Secure` flag. Normally derived from `x-forwarded-proto`/the request's own scheme, not `NODE_ENV` — only set this if your proxy doesn't forward that header reliably. |

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

### Locking the whole app to your account (`CG_OWNER_GITHUB_LOGIN`)
By default, once GitHub sign-in is configured, repos indexed anonymously still land in a shared public bucket anyone can see/index into — sign-in only makes *your own* repos private. To instead make the **entire deployment** (every page, every API route) usable only by you:

1. Complete the GitHub sign-in setup above first (`CG_OWNER_GITHUB_LOGIN` fails closed with a 500 if OAuth isn't fully configured — it never silently opens the app back up).
2. Set `CG_OWNER_GITHUB_LOGIN=<your-github-username>` (comma-separate multiple logins for a small team, e.g. `alice,bob`).
3. Restart/redeploy. Now:
   - An anonymous visitor hitting any page is redirected to GitHub sign-in; any API route returns `401`.
   - A visitor signed in with a GitHub account **not** on the allowlist gets a static "Access Restricted" page (pages) or a `403` (API) — never a redirect loop.
   - `GET /api/health` and the GitHub OAuth routes themselves (`/api/auth/github*`) always stay reachable, so health checks and the sign-in flow that satisfies this very check never get blocked by it.
4. This is enforced once, in `src/proxy.ts` (Next.js's middleware entry point) — no individual route needed changes, and it applies uniformly to pages, `/api/repos`, `/api/index`, `/api/settings/*`, the AI Assistant routes, everything.

**What this grants**: the OAuth scope requested is `repo read:user` — GitHub's classic OAuth has no finer-grained read-only scope, so this is full read/write access to the signed-in user's repos (needed to clone private ones at all) plus their public profile. The token is held only in an encrypted, `httpOnly` session cookie — never written to disk, never returned in any API response, and only ever sent back to `github.com` itself (see `lib/session.ts` and the `runJob` host check in `lib/store.ts`).

## AI Assistant setup (optional — two independent backends)
Adds a chat panel to the Editor tab. Either backend, both, or neither may be configured; if both are, a small selector in the panel lets you switch (starting a fresh conversation with the new backend). Fully optional and off by default; skip this section if you don't need either.

Configuration lives in two places that stack: env vars (`ANTHROPIC_API_KEY`, `CG_LOCAL_LLM_BASE_URL`/`CG_LOCAL_LLM_MODEL`/`CG_LOCAL_LLM_API_KEY`, `CG_CLAUDE_MODEL`) set a deployment-wide default, and the in-app **Settings page** (`/settings`) lets any signed-in user override them for themselves without touching the deployment's environment. **A value saved through the Settings page is scoped to the GitHub account that saved it** (`settings` table's `PRIMARY KEY (key, user_id)`) — never visible to, or overwritable by, a different signed-in account, and never falls back to another account's saved value. If GitHub sign-in (above) isn't configured at all, or a visitor isn't signed in, Settings changes go to a single shared "no account" bucket instead — the same single-shared-config behavior as before this scoping existed, appropriate for a self-hosted single-operator instance.

### Claude (Claude Agent SDK)
Runs in-process against the repo's live workspace directory.

1. Set `ANTHROPIC_API_KEY=<your key>` on the deployment (and/or in a local `.env.local` for dev). Restart/redeploy.
2. `npm install` already pulls the correct platform binary via `@anthropic-ai/claude-agent-sdk`'s `optionalDependencies` (Linux glibc/musl x64+arm64, macOS, Windows), so this works in the Docker image with no extra install step.
3. **To use your Claude Pro/Max/Team subscription instead of an API key** (the "Use my Claude subscription" toggle on the Settings page), CodeGraph requires real evidence this exact server process can authenticate — an `ANTHROPIC_API_KEY`-free login. On a hosted/container deployment (Render, Docker, etc.) there's no persistent home directory and no interactive terminal to ever run `claude login` directly on the server, so the only way this works is a portable long-lived token:
   1. On **your own computer** (not the server) — run `npx @anthropic-ai/claude-code setup-token` (or `claude setup-token` if you already have Claude Code installed globally). This is a real subcommand of the official CLI: `Set up a long-lived authentication token (requires Claude subscription)`.
   2. It opens a browser to sign in with your Claude.ai account (Pro/Max/Team) — or prints a URL/code to paste manually if a browser can't open (e.g. over SSH).
   3. On success it prints a token valid for **1 year**: `Your OAuth token (valid for 1 year): ... Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>`. Copy it now — you won't be able to see it again.
   4. Set `CLAUDE_CODE_OAUTH_TOKEN=<that token>` on the deployment (Render dashboard → your service → Environment → Add Environment Variable) and redeploy/restart.
   5. CodeGraph checks for this evidence server-side (`claudeSubscriptionCredentialsAvailable()` in `lib/settings.ts`) before ever offering Claude via the subscription path, so the toggle only "just works" once the token is actually set — no server-side login needed beyond this one env var.

### Local model (any OpenAI-compatible server)
Talks over plain HTTP to a model server running on your own hardware — no data leaves the machine running CodeGraph. Tested against the OpenAI-compatible `/v1/chat/completions` shape that Ollama, LM Studio, llama.cpp's `server`, vLLM, and text-generation-webui all implement; tool-calling quality (and therefore how well the assistant can actually edit files) depends entirely on the model you pick — recent tool-calling-tuned models (e.g. Qwen2.5-Coder, Llama 3.1+) work noticeably better than older/small ones.

1. Start your model server and note its OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` for Ollama, `http://localhost:1234/v1` for LM Studio.
2. Set `CG_LOCAL_LLM_BASE_URL` and `CG_LOCAL_LLM_MODEL` on the deployment (and/or in a local `.env.local` for dev). Restart/redeploy.
3. If running CodeGraph itself in Docker while the model server runs on the host, point `CG_LOCAL_LLM_BASE_URL` at the host (e.g. `http://host.docker.internal:11434/v1` on Docker Desktop) rather than `localhost`, which inside the container means the container itself.

### Both backends
An "AI Assistant" icon appears in the Editor tab's activity bar automatically once at least one backend is configured — no other config needed, and nothing changes for anyone if you leave both unset.

**What this grants**: nothing beyond the app's own workspace tools, for either backend. The assistant gets zero built-in Claude Code tools (`tools: []`, `strictMcpConfig: true`, `settingSources: []` in `lib/agents/assistant.ts`) and the local-model path has no built-in tools to begin with — no Bash, no raw filesystem access, no project settings/hooks/plugins, for either. Both backends' only capabilities are the same nine tools (`lib/agents/workspaceToolImpls.ts`), thin wrappers over the exact path-safe helpers the human-facing Editor already uses (`lib/workspace.ts`'s `resolveSafe`-guarded fs ops, `lib/gitops.ts`'s argv-only git wrapper) — the same traversal/injection guarantees apply regardless of which model is driving the chat. Sessions are per-repo, in-process, and never written to disk (`persistSession: false` for Claude; the local backend never had a disk-persistence path to begin with); a server restart drops all AI Assistant conversation history with no cleanup required.

- `GET /api/health` → `{ status: "ok", localAccessAllowed }` (200). Use for LB/Docker/K8s probes. Deliberately excludes `uptime`/timestamps — unauthenticated reconnaissance value with no legitimate client use.
- Jobs are persisted in SQLite; a crashed indexing job is retriable by re-submitting.
- Indexing runs in-process (fire-and-forget). For high throughput, front with a queue (future work).

## Security notes
- Anonymous git URLs must be public; `GIT_TERMINAL_PROMPT=0` prevents credential prompts. A signed-in GitHub user (see above) can additionally clone their own private repos, authenticated with their own OAuth token — never anyone else's.
- Repo URL is validated (`^https?://…`) and SSRF-guarded (rejects loopback/private/link-local hosts, see `lib/urlSafety.ts`) before use; clone runs with a timeout + output cap.
- Local-folder indexing is **off by default on a public deployment** (`CG_ALLOW_LOCAL_ACCESS`) — self-hosted/trusted-host use only; never turn it on for untrusted visitors on a shared host.
- No secrets are required for the core product — the agent swarm is deterministic and needs **no LLM API key**. GitHub sign-in (needs a secret) and the two optional AI Assistant backends (Claude needs a secret; the local-model backend needs no secret at all — it's just an HTTP call to hardware you already control) are the only opt-in extras; everything else runs with zero credentials.

## Scaling path (documented, not yet implemented)
1. Move indexing to a worker queue (Redis/BullMQ) — API stays; `store.createIndexJob` enqueues.
2. Swap SQLite → Postgres (`pgvector`) via the same `store` interface for multi-tenant scale + real embeddings.
3. ~~Incremental re-index (only changed files re-parsed).~~ **Shipped.** A run reuses the
   previous run's per-file symbol extraction, keyed by content hash plus the transitive
   import closure, and rebuilds the TypeScript program over the invalidated files alone; the
   cache is a gzipped manifest per workspace root under `<CG_DATA_DIR>/index-cache/`.
   Measured on this repository: 2,255ms cold → 368ms after a one-file edit, 125ms with no
   change, byte-identical results (`packages/analysis/tests/incremental.test.ts`). Editor
   writes and git commit/pull/checkout schedule one automatically after a 10s quiet period;
   `POST /api/repos/:id/reindex` is the explicit trigger. Webhook-driven re-index is still
   open — nothing listens to GitHub events yet.

## CI checklist
Run from the repo root, not `apps/web` — this is an npm workspace.
```bash
npm ci               # never `npm install` at the root (see CLAUDE.md §4)
npm run typecheck    # every workspace
npm run depcruise    # HLD §6.1 layering + cycle gate
npm run boundaries   # process.env / console.* confinement
npm run test         # vitest, all workspaces
npm run build        # standalone build
```

## Logs
Application logs are **structured JSON, one object per line, on stderr**
(`{"level","time","msg",...}`). Before P1 these were free-text `console.warn`
/`console.error` lines; the destination is unchanged, so `docker logs` and any
existing log drain keep working, but a grep written against the old prose
wording needs updating.

Errors are serialised with `name`/`message`/`stack` — `JSON.stringify` alone
drops all three, since they are non-enumerable, which is why a logged error used
to appear as `{}`.

No log-level filter yet: every level is emitted, exactly as the previous
`console.*` calls always printed. `CG_LOG_LEVEL` arrives with the worker in P2,
where there is enough volume to justify it.

A raw exception is never returned to a client — the detail goes to the log and
the response carries a stable, generic message (CLAUDE.md §5).

## Backup / restore
- State is a single file: `data/codegraph.sqlite` (+ `-wal`, `-shm`). Back up the `data` volume.
- Restore by placing the file back and restarting.

## Built-in editor workspaces
- Indexing a **git** repo now clones it into `data/workspaces/<repoId>/` (depth 50, all branches) instead of a disposable temp dir, so the Editor tab has a live working tree to read/write/commit against. This lives on the same persistent disk as the SQLite DB — bump `disk.sizeGB` in `render.yaml` (or the `codegraph-data` volume) if you index many/large repositories.
- Deleting a git-sourced repo removes its `workspaces/<repoId>` directory. Deleting a **local**-sourced repo never touches disk — its "workspace" is the user's real folder passed in at index time.
- The remediation executor (`/api/repos/:id/fix`) is unaffected: it still clones into a disposable `os.tmpdir()` sandbox and removes it when done.