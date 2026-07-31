# CodeGraph — Architecture

**This is the current, accurate description of the real, running product.** For an earlier, unbuilt design (Python/Postgres/NATS/Temporal), see `docs/archive/legacy-design/` — none of that is what's deployed.

## What it is
A single Next.js 16 (App Router) application at `apps/web/` that:
1. Clones a public git repo — or a signed-in user's own private repo (see GitHub sign-in) — or reads a local folder (gated — see Security) and builds a lightweight knowledge graph of its structure.
2. Computes a blast-radius-weighted, explainable 0–100 **Health Score**.
3. Renders three interactive visualizations (Architecture flowchart, zoomable Circle-pack, force-directed Network).
4. Exposes a symbol-level **Code Intelligence** layer (search, callers/callees, impact, circular-deps, dead-code, Graph-RAG context generation).
5. Runs a deterministic (no LLM, no API key) **7-agent swarm** — Security/Performance/Refactor/Dead-code/Dependency/Architecture/Test specialists → Critic → Judge — producing a ranked remediation plan, with a sandboxed Fixer that can patch and verify a fix.
6. Provides a built-in, Git-integrated code editor (Monaco) with file explorer, restorable trash, search/replace, and commit/push.

## Stack (what's actually used, not planned)
| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Persistence | `node:sqlite` (built into Node ≥22) — one file, `data/codegraph.sqlite` |
| Parsing | TypeScript compiler API and `web-tree-sitter` (WASM) for TS/JS, regex extractors as the fallback. The old `CG_TREE_SITTER_MAX_RSS_BYTES` budget gate is gone — see Known constraints |
| Editor | Monaco, loaded from a CDN at runtime (not bundled) |
| Deployment | Docker (`node:24-slim`), **one container** running two processes: the Next.js server and `apps/worker`. The job queue is a **SQLite table**, not a broker — no NATS, no Redis, no orchestrator |
| Auth | None by default; optional HTTP Basic Auth gate (app-wide) + optional GitHub OAuth (per-user, unlocks private-repo import) — see Security |

No Postgres, no pgvector, no NATS, no Temporal, no runtime/OTel domain — all of that was scoped in the legacy design docs but never built. This app trades graph sophistication for "actually ships and runs on a single small container."

## Request flow

An npm-workspaces monorepo: `apps/*` are deployment units, `packages/*` are libraries, and the
dependency direction between packages is enforced in CI by `.dependency-cruiser.cjs` (HLD §6.1)
rather than by convention.

```
Browser (Next.js client pages, apps/web/src/app/*)
        │  fetch
        ▼
API routes (apps/web/src/app/api/*/route.ts)   ← 28 routes, thin HTTP glue
        │
        ▼
apps/web/src/lib/*        web-only concerns: session, authz, store, agents, editor, timeline
        │
        │  enqueue (a row in the `jobs` table)
        ▼
apps/worker               poll · lease · heartbeat · spawn a CHILD PROCESS per job
        │
        ▼
packages/*                the analysis itself — see below
```

The libraries, and why each boundary exists:

| Package | Owns |
|---|---|
| `core-domain` | Pure types and fingerprints. Zero dependencies, zero I/O |
| `config` | Typed environment, validated at boot. The **only** module that reads `process.env` |
| `observability` | Structured logging. The **only** module allowed `console.*` |
| `fsx` | Path-safe workspace file operations (was `lib/workspace.ts`) |
| `vcs` | Everything that shells out to `git`, plus the GitHub client and the SSRF guard (was `lib/urlSafety.ts`) |
| `sandbox` | Process execution for verification gates — timeout, no shell, scrubbed env |
| `persistence` | The **only** module that speaks SQL |
| `jobs` | Queue semantics: lease, heartbeat, retry, cancellation |
| `analysis` · `analysis-model` · `core-graph` | Scan, symbol graph, detection rules. Still transitional; LLD §13 splits `analysis` further into `pipeline`/`lang-*`/`detect-engine`/`viz` |
| `score-engine` | The Health Score model — pure functions of findings plus LOC, no I/O. Split out first because the swarm's projected score re-runs the REAL scorer (review C5), which meant importing it from the indexer and dragging in the walker, the ESLint layer and the TypeScript program |
| `remediate-engine` | Fix providers and the apply loop, shared by `apps/web` and `apps/cli` |
| `verify` | The four verification gates and the `VerificationRecord` |
| `calibrate` | Offline defect labelling for score calibration (PLAN.md §5.3). Depends on `vcs` and nothing else — a calibration run must not be able to reach the scorer it is fitting weights for |

The last two `process.env` and `console.*` rules are enforced by `scripts/check_boundaries.py`,
which dependency-cruiser structurally cannot see.

**Two dispatch paths, chosen by `CG_USE_WORKER`.** The shipped image sets it to `true`: routes
write a row to the `jobs` table and return `202`, and the worker claims it and spawns a child
process that exits when the job ends. `npm run dev` leaves it off and calls `void runJob(...)`
inline, so a developer does not need two processes to see a repo index.

That child-per-job structure is not tidiness — it is the fix for the OOM in Known constraints
below, and it is what makes an unhandled crash mid-job kill one job rather than the server.

Note that `apps/web/src/lib/indexer.ts` and `apps/web/src/lib/codeintel/*` still exist as
**re-export shims** pointing at the packages. They are deleted once no importers remain
(LLD §13.1 step 3); the real code is not there.

## Security model
- **No authentication by default.** Optional HTTP Basic Auth: set `CG_BASIC_AUTH_PASSWORD` (and optionally `CG_BASIC_AUTH_USER`, default `codegraph`) to gate the whole app except `/api/health`. See `apps/web/src/proxy.ts`.
- **Local-folder indexing and server-side folder browsing are disabled in production by default** (`apps/web/src/lib/localAccess.ts`) — they read arbitrary paths on whatever machine runs the server, which is fine for self-hosted/local-dev use and a live file-disclosure risk on a shared public deployment. Opt in explicitly with `CG_ALLOW_LOCAL_ACCESS=true` only on a trusted single-operator host.
- **Git URLs are validated against SSRF** (`apps/web/src/lib/urlSafety.ts`) — loopback/private/link-local hosts are rejected before `git clone` runs. This is a best-effort literal-IP check, not DNS-rebinding-proof.
- **Filesystem path traversal is defended** within a workspace root (`resolveSafe` in `workspace.ts`), verified against `../../../etc/passwd`-style attempts.
- Security headers (CSP, X-Frame-Options, etc.) are set in `apps/web/next.config.ts`. The CSP allows Monaco's CDN (`cdn.jsdelivr.net`) and Next's inline hydration scripts — see the comment there for why it isn't a strict nonce-based policy.
- **Optional GitHub sign-in** (`apps/web/src/lib/session.ts`, `apps/web/src/lib/githubOAuth.ts`, off unless `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`/`CG_SESSION_SECRET` are all set — see `DEPLOY.md`) lets a user browse and import their own repos, including private ones. No server-side session store: the GitHub access token lives only inside an AES-256-GCM-encrypted, `httpOnly` cookie — never persisted to SQLite, never returned by any API response (`/api/auth/me` echoes only login/name/avatar). When cloning, the token is only ever spliced into a URL whose host is verified to be exactly `github.com` (`store.ts`'s `runJob`), so a session can't be tricked into leaking its token to a third-party remote.
- **Repos are tenant-scoped by `owner_id`** (`repos` table, `apps/web/src/lib/authz.ts`). A repo indexed while signed out lands in a shared public bucket (`owner_id IS NULL`) — visible/mutable by anyone, matching the no-login "paste a URL" flow. A repo indexed while signed in with GitHub is private to that account's `userId`: `listRepos()` filters to the viewer's own rows plus the public bucket, and every `/api/repos/[id]/*` route (`fs`, `git`, `search`, `fix`, `agents`, `intel`, `trash`, delete) calls `repoAccessDenied()` first. A non-owner gets a 404 — identical to a nonexistent repo — never a 403, so a private repo's existence isn't leaked either. Regression tests: `apps/web/tests/tenant-isolation.test.ts`.
- Full current status and remaining work: `docs/PROGRESS_TRACKER.md`.

## Known constraints (learned the hard way — see `docs/postmortems/`)
- **`web-tree-sitter`'s WASM memory only grows, never shrinks**, for the lifetime of the process (~26 MB per parsed file, measured — see `docs/postmortems/2026-07-10-tree-sitter-oom.md`). This is now handled **structurally rather than by a budget**: analysis runs in `apps/worker`, which spawns a child process per job and lets it exit, and process exit reclaims the arena unconditionally. The `CG_TREE_SITTER_MAX_RSS_BYTES` gate this entry used to describe **no longer exists in the code** — it was an RSS-measuring fallback to the regex extractor, i.e. a way to degrade analysis quality to avoid an OOM, and per-job process isolation removes the need to make that trade. Verified at the constraint: two concurrent index jobs at `--memory=512m --cpus=0.5` both completed, peak RSS 341.8 MiB of 512, no OOM kill. Enabled in the container via `CG_USE_WORKER=true` (set in the Dockerfile); `npm run dev` still analyses in-process, so use `npm run dev:worker` alongside it to exercise the real path.
- **Never drop privileges in the Docker container.** A prior fix used `setpriv` to run as non-root after fixing disk-mount ownership; Render doesn't grant `CAP_SETUID`, so it crash-looped. The container now runs as root for its whole lifetime — see `docs/postmortems/2026-07-10-render-crash-loop.md`.
- **A platform-mounted persistent disk (Render) is not a Docker named volume** — it doesn't inherit the image's baked-in ownership, and comes up empty/root-owned on every restart if the container also isn't root. Local Docker testing with named volumes will not reproduce this; use `--tmpfs /app/data:uid=0,gid=0` to simulate it.

## Where to go next
- Product-level detail: `apps/web/README.md`, `apps/web/AGENTS.md`, `apps/web/CODE_INTELLIGENCE.md`.
- Ops/deployment: `apps/web/DEPLOY.md`.
- What's planned vs. done: `docs/IMPROVEMENT_PLAN.md` + `docs/PROGRESS_TRACKER.md`.
- Incident history: `docs/postmortems/`.
