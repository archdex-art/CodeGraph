# SecurityCheck.md — production security audit log

Purpose: a running brief so any AI model (or engineer) picking this up mid-flight knows what
has been audited, what was found, what was fixed, and what is left. Updated after **every
milestone**.

Full report with evidence, exploitation paths and CWEs:
[`docs/SECURITY_AUDIT_2026-08-08.md`](./docs/SECURITY_AUDIT_2026-08-08.md).

Scope: whole repo — `apps/web`, `packages/*`, `apps/worker`, `apps/cli`, Docker/Render/CI.
Method: OWASP Top 10 / API Top 10 / ASVS, CWE mapping. Verified findings only.

---

## Milestone log

### M0 — Baseline (done)

`npm run typecheck` 0 · `npx vitest run` 1274/1274 (91 files) · tree at `057da26`.
Prior hardening read and treated as closed: `docs/AUDIT_2026-07-12.md`, tracker Phases 0/7,
commits `180168f`, `79a943a`, `057da26`.

### M1 — Audit fan-out (done)

Five parallel read-only passes: authn/authz across all ~29 API routes, injection
(SQL/argv/path/SSRF/ReDoS/deserialization), frontend (XSS/CSP/storage/leakage), infrastructure
(Docker/Render/CI/supply chain), business logic (races, DoS, rate limits, log hygiene, LLM tool
surface). Two passes failed mid-run and were re-dispatched; the repo-route half was audited by
the lead directly.

### M2 — Verification (done)

Every reported finding re-checked against current code by the lead; speculative ones dropped
(e.g. "`/api/browse` needs a session" — it is gated by an explicit deployment opt-in that is off
in production by default, and requiring a session would break the single-operator self-host
case). Two criticals reproduced before fixing.

### M3 — Remediation (done)

| ID | Severity | CWE | Location | Fix |
|---|---|---|---|---|
| S-01 | **Critical** | CWE-94/668 | `packages/fsx/src/workspace.ts` | Workspace API could write `.git/hooks/*` → `git commit` executed it as root. `resolveSafe` now refuses any `.git` segment |
| S-02 | **Critical** | CWE-59 | `packages/analysis/src/indexer.ts` | Indexer walk followed symlinks out of the clone (host files into the graph). `lstatSync` + skip |
| S-03 | High | CWE-22/88 | `lib/gitops/timelineStore.ts`, `snapshotLoader.ts`, timeline route | Commit hash from a query param was a path and a git argv token → cross-tenant snapshot read. `isCommitHash` at all three boundaries |
| S-04 | Medium | CWE-918 | `packages/vcs/src/acquire.ts` | `git clone` followed a 302 past the SSRF guard. `-c http.followRedirects=false` |
| S-05 | Medium | CWE-209 | timeline route | Raw exception text (git stderr, absolute workspace paths) returned to clients. Narrowed |
| S-06 | Low | CWE-770 | `api/settings/assistant` | Unthrottled outbound Anthropic verification call. Rate limited 20/min |
| S-07 | Low | CWE-319 | `apps/web/next.config.ts` | HSTS header added |
| S-08 | Low | CWE-276 | `.github/workflows/ci.yml` | `permissions: contents: read` |

New regression tests (12 cases, 3 files): `packages/fsx/tests/containment.test.ts` (+5),
`packages/analysis/tests/symlink-containment.test.ts`, `apps/web/tests/timeline-hash.test.ts`,
`packages/vcs/tests/clone-redirect.test.ts`.

### M4 — Re-verification (done)

`npm run typecheck` 0 · `npx vitest run` **1286/1286** (94 files) · `npm run depcruise` clean ·
`npm run build` clean. Plus: S-01 chain reproduced pre-fix and refused post-fix at both the fsx
and HTTP-route layers; S-02 tests fail with the fix reverted; S-04 proved against a real
redirecting server.

---

## Remaining architectural recommendations (documented, NOT implemented)

Detail in the report's final section.

| ID | Item | Why not fixed here |
|---|---|---|
| A-01 | Jobs run in-process, unbounded (`CG_USE_WORKER=false` default) | Needs worker-mode default + global concurrency ceiling; behavioural change |
| A-02 | No aggregate cap on SSE streams | Needs a connection registry and shared tick |
| A-03 | CSP keeps `unsafe-inline`/`unsafe-eval` (Monaco + Next hydration) | Nonce migration needs `report-to` telemetry and staged rollout |
| A-04 | SSRF guard cannot stop DNS rebinding | Needs resolve-and-pin acquisition or platform egress allowlist |
| A-05 | Container runs as root (Render constraint) | Platform capability probe + entrypoint privilege drop |
| A-06 | Assistant auto-approves its own tool calls | Safe only because the tool surface is nine path-safe wrappers; wants a surface assertion test + confirmation on mutating tools |
| A-07 | Anonymous repos share one world-writable bucket | Product decision; per-visitor anonymous identity would close it |
| A-08 | CI actions pinned by mutable tag | Repo-wide policy change (SHA pinning + Dependabot) |
