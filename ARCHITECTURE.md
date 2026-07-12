# CodeGraph — Architecture

**This is the current, accurate description of the real, running product.** For an earlier, unbuilt design (Python/Postgres/NATS/Temporal), see `docs/archive/legacy-design/` — none of that is what's deployed.

## What it is
A single Next.js 16 (App Router) application at `app/` that:
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
| Parsing | `web-tree-sitter` (WASM) for TS/JS when memory budget allows, regex-based extractors as the default/fallback (see Known Constraints) |
| Editor | Monaco, loaded from a CDN at runtime (not bundled) |
| Deployment | Docker (`node:24-slim`), single container, no queue/orchestrator/message bus |
| Auth | None by default; optional HTTP Basic Auth gate (app-wide) + optional GitHub OAuth (per-user, unlocks private-repo import) — see Security |

No Postgres, no pgvector, no NATS, no Temporal, no runtime/OTel domain — all of that was scoped in the legacy design docs but never built. This app trades graph sophistication for "actually ships and runs on a single small container."

## Request flow
```
Browser (Next.js client pages, src/app/*)
        │  fetch
        ▼
API routes (src/app/api/*/route.ts)   ← 14 routes, thin HTTP glue
        │
        ▼
Backend lib (src/lib/*)
  ├─ store.ts        job orchestration + SQLite persistence (fire-and-forget in-process jobs)
  ├─ indexer.ts       clone/scan/score a repo → IndexResult
  ├─ codeintel/       tree-sitter + regex extractors → symbol graph, health-score dimensions
  ├─ agents/          specialists → critic → judge → (optional) sandboxed fixer
  ├─ workspace.ts      path-safe fs ops scoped to a repo's workspace dir
  ├─ trash.ts          soft-delete layer for editor deletes (restorable)
  ├─ gitops.ts          thin, argv-only wrapper over `git` (no shell interpolation)
  ├─ localAccess.ts     gates local-folder indexing / server-side folder browsing
  ├─ urlSafety.ts        SSRF guard for user-supplied git URLs
  ├─ basicAuth.ts         pure credential-check for the optional app-wide auth gate
  ├─ session.ts            stateless, encrypted session cookie for GitHub sign-in
  ├─ githubOAuth.ts         GitHub OAuth client (authorize URL, token exchange, repo listing)
  └─ authz.ts               per-repo ownership check (repoAccessDenied/viewerId) enforced on every repos/[id]/* route
```

Jobs are fire-and-forget within the same Node process (`void runJob(...)` in `store.ts`) — there's no external queue. This is simple and fine for single-instance deployment; it does mean an unhandled crash mid-job takes the whole server down with it (see `docs/postmortems/`).

## Security model
- **No authentication by default.** Optional HTTP Basic Auth: set `CG_BASIC_AUTH_PASSWORD` (and optionally `CG_BASIC_AUTH_USER`, default `codegraph`) to gate the whole app except `/api/health`. See `app/src/proxy.ts`.
- **Local-folder indexing and server-side folder browsing are disabled in production by default** (`app/src/lib/localAccess.ts`) — they read arbitrary paths on whatever machine runs the server, which is fine for self-hosted/local-dev use and a live file-disclosure risk on a shared public deployment. Opt in explicitly with `CG_ALLOW_LOCAL_ACCESS=true` only on a trusted single-operator host.
- **Git URLs are validated against SSRF** (`app/src/lib/urlSafety.ts`) — loopback/private/link-local hosts are rejected before `git clone` runs. This is a best-effort literal-IP check, not DNS-rebinding-proof.
- **Filesystem path traversal is defended** within a workspace root (`resolveSafe` in `workspace.ts`), verified against `../../../etc/passwd`-style attempts.
- Security headers (CSP, X-Frame-Options, etc.) are set in `app/next.config.ts`. The CSP allows Monaco's CDN (`cdn.jsdelivr.net`) and Next's inline hydration scripts — see the comment there for why it isn't a strict nonce-based policy.
- **Optional GitHub sign-in** (`app/src/lib/session.ts`, `app/src/lib/githubOAuth.ts`, off unless `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`/`CG_SESSION_SECRET` are all set — see `DEPLOY.md`) lets a user browse and import their own repos, including private ones. No server-side session store: the GitHub access token lives only inside an AES-256-GCM-encrypted, `httpOnly` cookie — never persisted to SQLite, never returned by any API response (`/api/auth/me` echoes only login/name/avatar). When cloning, the token is only ever spliced into a URL whose host is verified to be exactly `github.com` (`store.ts`'s `runJob`), so a session can't be tricked into leaking its token to a third-party remote.
- **Repos are tenant-scoped by `owner_id`** (`repos` table, `app/src/lib/authz.ts`). A repo indexed while signed out lands in a shared public bucket (`owner_id IS NULL`) — visible/mutable by anyone, matching the no-login "paste a URL" flow. A repo indexed while signed in with GitHub is private to that account's `userId`: `listRepos()` filters to the viewer's own rows plus the public bucket, and every `/api/repos/[id]/*` route (`fs`, `git`, `search`, `fix`, `agents`, `intel`, `trash`, delete) calls `repoAccessDenied()` first. A non-owner gets a 404 — identical to a nonexistent repo — never a 403, so a private repo's existence isn't leaked either. Regression tests: `app/tests/tenant-isolation.test.ts`.
- Full current status and remaining work: `docs/PROGRESS_TRACKER.md`.

## Known constraints (learned the hard way — see `docs/postmortems/`)
- **`web-tree-sitter`'s WASM memory only grows, never shrinks**, for the lifetime of the process. On a memory-constrained host (Render's 512MB Starter plan), parsing more than a handful of files can OOM-kill the whole server. `ast-extractor.ts` gates real AST parsing on live measured RSS (`CG_TREE_SITTER_MAX_RSS_BYTES`, default effectively disabled) and falls back to the regex extractor once the budget's spent. Raise this only with real memory headroom (bigger plan, self-hosted).
- **Never drop privileges in the Docker container.** A prior fix used `setpriv` to run as non-root after fixing disk-mount ownership; Render doesn't grant `CAP_SETUID`, so it crash-looped. The container now runs as root for its whole lifetime — see `docs/postmortems/2026-07-10-render-crash-loop.md`.
- **A platform-mounted persistent disk (Render) is not a Docker named volume** — it doesn't inherit the image's baked-in ownership, and comes up empty/root-owned on every restart if the container also isn't root. Local Docker testing with named volumes will not reproduce this; use `--tmpfs /app/data:uid=0,gid=0` to simulate it.

## Where to go next
- Product-level detail: `app/README.md`, `app/AGENTS.md`, `app/CODE_INTELLIGENCE.md`.
- Ops/deployment: `app/DEPLOY.md`.
- What's planned vs. done: `docs/IMPROVEMENT_PLAN.md` + `docs/PROGRESS_TRACKER.md`.
- Incident history: `docs/postmortems/`.
