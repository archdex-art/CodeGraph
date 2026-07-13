# CodeGraph — Improvement Plan

**Created:** 2026-07-10
**Basis:** Live audit of the actual deployed app (`app/`, Next.js + SQLite) — not the earlier Python/Postgres design docs (`00`–`08`, `PROJECT_REPORT.md`, `DECISIONS.md`), which describe a different, unbuilt architecture. See Phase 3 for reconciling that.
**Baseline scores:** Security **3/10** · Overall **7/10** (see `PROGRESS_TRACKER.md` for the live scorecard)

## How to use this document
- Work phases **in order** — later phases assume earlier ones are done (e.g., don't add product features on top of a public arbitrary-file-read hole).
- Each task has an effort estimate, priority, and a concrete **acceptance criterion** — a fact you can check, not a vibe.
- Check off progress in `PROGRESS_TRACKER.md`, not here. This file is the plan; the tracker is the live status.

---

## Phase 0 — Security Lockdown
**Priority: Critical. Do this before anything else — the app is live and publicly reachable right now.**

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 0.1 | Gate or disable "local folder" indexing + `/api/browse` in production | S (~30 min) | With `NODE_ENV=production` and no explicit opt-in env var set, `POST /api/index {sourceType:"local"}` and `GET /api/browse` return 403, not filesystem data |
| 0.2 | Harden git URL validation against SSRF | S (~1 hr) | `POST /api/index {repoUrl:"http://localhost/..."}` and `http://169.254.169.254/...` are rejected before `git clone` runs |
| 0.3 | `npm audit fix` + resolve remaining advisories | S (~30 min) | `npm audit --production` reports 0 moderate/high vulnerabilities |
| 0.4 | Add an access gate to the public deployment (shared password, or real auth) | M (~2–3 hrs) | Anonymous requests to `/api/*` (except `/api/health`) get 401 without a valid session/token |
| 0.5 | Add security headers (CSP, X-Frame-Options, X-Content-Type-Options) | S (~30 min) | Response headers on `/` include a restrictive `Content-Security-Policy` |

**Phase 0 exit gate:** an anonymous visitor to the live URL cannot read any file outside their own indexed repos.

---

## Phase 1 — Reliability Guardrails
**Priority: High. Three production-breaking bugs shipped to `main` undetected today — nothing currently catches that.**

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 1.1 | GitHub Actions CI: run `npm run test` + `npm run build` on every push/PR | S (~30 min) | A PR with a failing test shows a red check before merge is possible |
| 1.2 | Branch protection on `main`: require the CI check to pass | XS (~5 min, GitHub UI) | Direct pushes to `main` with a failing build are rejected |
| 1.3 | Post-deploy smoke-test script (`scripts/smoke.sh`): health check + index a small public repo + poll to `done` | S (~1 hr) | Running it against a fresh deploy exits non-zero if indexing doesn't complete within a timeout |
| 1.4 | Write up today's 3 incidents (disk perms, tree-sitter hang, OOM) as short postmortems | S (~1 hr) | `docs/postmortems/` has one file per incident: symptom, root cause, fix commit, prevention |

**Phase 1 exit gate:** a broken commit cannot reach production without a human explicitly overriding CI.

---

## Phase 2 — Test Coverage Expansion
**Priority: Medium. Current tests cover the analysis "engines"; the API surface (14 routes) has ~zero coverage.**

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 2.1 | Route tests for `/api/index`, `/api/repos/:id/fs`, `/api/repos/:id/trash` | M (~3–4 hrs) | Path-traversal and malformed-input cases have explicit `it()` blocks, not just manual curl checks |
| 2.2 | Regression test locking Phase 0.1 (local-folder gate) and 0.2 (SSRF guard) | S (~1 hr) | Deleting the gate/guard code fails a test, not just a manual check |
| 2.3 | Docker-based integration test in CI: build image, run under a memory cap, index a real repo | M (~2–3 hrs) | CI fails if a future change reintroduces the OOM/hang/permission classes of bug fixed today |

**Phase 2 exit gate:** the specific failure modes fixed today are enforced by CI, not just tribal knowledge.

---

## Phase 3 — Documentation Cleanup
**Priority: Medium. `PROJECT_REPORT.md` currently describes an abandoned Python/Postgres/NATS/Temporal architecture that was never built — actively misleading for anyone new to the repo.**

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 3.1 | Move `00_blueprint.md`…`08_api_and_schema.md`, `DECISIONS.md`, `PROJECT_REPORT.md`, `codegraph/` (Python) into `docs/archive/legacy-design/` with a one-line README explaining they predate and were superseded by `app/` | S (~30 min) | Root directory no longer mixes live and historical docs |
| 3.2 | Write one accurate top-level `ARCHITECTURE.md` describing the actual Next.js/SQLite/deterministic-agent app | M (~2 hrs) | A new contributor can read one file and understand the real system, no archaeology required |
| 3.3 | Update root `README.md` to point at `app/` as the actual product, remove ambiguity | S (~30 min) | README's first paragraph names `app/` as the real, running product |

**Phase 3 exit gate:** repo docs describe what's actually running, not what was once planned.

---

## Phase 4 — Product Differentiator: Close the Agent Loop
**Priority: Medium-High. This is the actual product wedge — right now the swarm produces a plan and the Fixer can patch+verify in a sandbox, but nothing ships the result anywhere.**

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 4.1 | PR-opening step: Fixer's verified sandbox diff → branch → commit → push → open PR via GitHub API | L (~1–2 days) | Clicking "Run Fix" on a P0/P1 finding results in a real, open PR on the target repo (using the user-supplied PAT, never stored) |
| 4.2 | Autonomy confirmation gate: show the diff and require explicit user confirmation before the PR step fires | S (~2 hrs) | No PR is opened without an explicit "Confirm" click |
| 4.3 | Surface the execution/audit trail (what the Fixer tried, what verification ran) in the UI | M (~3–4 hrs) | Each fix attempt has a visible, replayable log, not just a pass/fail |

**Phase 4 exit gate:** "open a verified PR fixing X" — the P0 exit criterion from the original design docs — actually happens, end to end, on a real repo.

---

## Phase 5 — Scale & Domains (Stretch)
**Priority: Low. Only start once Phases 0–4 are solid.**

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 5.1 | Second tree-sitter language extractor (Python), matching the precision the TS/JS path has (subject to the Phase-0-proven memory ceiling — budget accordingly) | L | Python repos get AST-grade symbols/references, not just regex |
| 5.2 | ~~Multi-tenant workspace isolation~~ — **done 2026-07-12, out of sequence.** Turned out to be live-severity, not a stretch item: GitHub sign-in (Phase 0.4/DEPLOY.md) let users import private repos into a globally-visible, globally-writable `repos` table with zero ownership checks. Fixed with an `owner_id` column + `app/src/lib/authz.ts`, enforced on every `/api/repos/[id]/*` route. See `ARCHITECTURE.md`'s security model and `app/tests/tenant-isolation.test.ts`. | XL | ✅ Two logged-in users cannot see each other's private repos; anonymous-indexed repos remain a shared public bucket by design |
| 5.3 | Runtime/observability domain (OTel ingestion) | XL | A "why is X slow" query can cite real production trace data |

## Phase 6 — Agent & Analysis Accuracy
**Priority: High, despite the numbering — recommend running before Phase 4.** Added 2026-07-12 from a direct code-reading assessment of the swarm (`orchestrator.ts`, `specialists.ts`, `codeintel/graph.ts`, `codeintel/query.ts`, `codeintel/ast-extractor.ts`), not the UI. Root finding: the agents' orchestration logic (critic dedupe, judge scoring) is sound; most of their *inaccuracy* traces to the call graph they're fed, not to agent logic itself. Phase 4 automates opening real PRs on top of these exact findings — doing that before fixing attribution/resolution risks shipping wrong-priority or misattributed fixes with a human's name on the commit. Sequence 6.1–6.4 (root cause) before Phase 4 at minimum; 6.5+ can follow either phase.

| # | Task | Effort | Acceptance criterion |
|---|---|---|---|
| 6.1 | Make `collectRefs` position-aware (`{name, line}[]`, not a flat count) and attribute each call to its enclosing symbol by line-range containment (`endLine` is already tracked per symbol) instead of `graph.ts`'s current "file's first function" fallback | M (~3–4 hrs) | A 3-function fixture file where only function B calls a given symbol resolves that call's caller edge to B, not to the file's first-defined function |
| 6.2 | Add per-file import-binding resolution before the global name-only fallback in `graph.ts` | M (~3–4 hrs) | Two files each define a same-named `parse()`; a third file that imports only one of them resolves its call to the imported one, not to whichever def was registered first in `defsByName` |
| 6.3 | Convert `query.ts`'s `cycles()` (Tarjan SCC) from recursive to iterative (explicit stack) | S (~1 hr) | A synthetic call chain 20,000+ deep does not stack-overflow `cycles()` |
| 6.4 | Replace the 1-hit-per-rule-per-file cap in `indexer.ts`'s `analyzeFiles` with a bounded top-N (e.g. 5) | XS (~20 min) | A file with 8 `eval()` calls reports up to 5 distinct findings, not 1 |
| 6.5 | Re-enable real AST extraction for TS/JS in production — replace the RSS-gated tree-sitter path (disabled by default: `MAX_RSS_BYTES` defaults to 0, so `rssBudgetExceeded()` is true on the very first check) with the TypeScript Compiler API, whose `ts.Program` instances are GC'able (no WASM-linear-memory-only-grows problem) | L (~1–2 days) | Indexing a real repo in the production container profile shows the AST path actually running (not silently falling back to regex), with RSS staying bounded across a 50+ file repo |
| 6.6 | Type-aware call resolution via `checker.getSymbolAtLocation` (depends on 6.5) | M (~1 day, mostly covered by 6.5's setup) | An overloaded/re-exported function resolves to its real definition against a synthetic barrel-re-export fixture |
| 6.7 | Replace flat per-agent confidence constants with evidence-derived values | S (~2 hrs) | Two findings from the same agent with different evidence strength (e.g. a regex match that also passes a validating guard vs. one that doesn't) produce different confidence scores |
| 6.8 | Loosen critic dedup in `orchestrator.ts`'s `critique()` from exact `file:line:title` match to locus-only (file:line±2) | S (~1 hr) | Two agents flagging the same line with differently-worded titles merge into one corroborated finding |
| 6.9 | Give the Test agent a real fan-in-vs-coverage intersection (`qe.hubs()` ∩ untested files) instead of a repo-wide test-ratio only | S (~2 hrs) | Test findings name the actual highest-fan-in untested function, not just a file-level ratio statistic |
| 6.10 | Add a cyclomatic/branching-complexity metric (count `if/else/for/while/case/catch/&&/\|\|/?:` per function) and feed it into the Refactor agent alongside raw LOC | S (~2–3 hrs) | A flat 600-line file and a deeply-nested 600-line file produce different Refactor severities |
| 6.11 | Feed git churn into judge scoring (`blastRadius × churn` hotspot formula) — confirmed zero git signal is used anywhere in the swarm today | M (~3–4 hrs) | A high-fan-in, frequently-committed file ranks above an equally-high-fan-in file untouched for a year, all else equal |
| 6.12 | Expand `fixers.ts` beyond the single `debugFixer` — add unpinned-dependency pinning, missing-lockfile note, hardcoded-local-URL removal | M (~1 day) | "Run Fix" produces a verified sandbox diff for at least 4 issue classes, not 1 |
| 6.13 | Add `orchestrator.test.ts` / `specialists.test.ts` — currently zero unit coverage for the swarm itself, unlike `indexer`/`executor`/`codeintel` | S (~2–3 hrs) | Critic-merge behavior, judge-score formula, priority thresholds, and projected-score bounds each have an explicit `it()` block |
| 6.14 | Surface the `truncated` (`MAX_SYMBOLS = 6000`) flag to the user | XS (~30 min) | A repo exceeding 6000 symbols shows a visible "partial results" notice in the UI/agent summary, not a silent cutoff |
| 6.15 | Swap hand-rolled security regexes for `eslint-plugin-security`/`eslint-plugin-no-unsanitized` as an additional TS/JS detector layer | L (~1–2 days) | A known unsafe-sink pattern the current 6 line-regexes miss is caught |
| 6.16 | Shallow taint reachability for the Security agent via `qe.impact()`/`qe.callers()` (depends on 6.1/6.2/6.5/6.6 for a trustworthy graph) | L (~1–2 days) | A fixture where untrusted input reaches `eval()` 2 hops away (not the same line) is flagged; one where it doesn't reach any sink is not |

**Phase 6 exit gate:** fanIn/fanOut/dead-code/cycle findings are provably attributed to the correct enclosing function and resolved through actual imports (not global name guessing) on a multi-file fixture with intentional name collisions; the swarm's scoring/prioritization logic has direct unit coverage.

---

## Effort key
XS < 15 min · S ≈ 30 min–1 hr · M ≈ 2–4 hrs · L ≈ 1–2 days · XL ≈ multi-day/week

## Projected score by phase completion

| After phase | Security | Overall | Why |
|---|---|---|---|
| Baseline | 3/10 | 7/10 | Live file-read hole, no CI, thin API test coverage, stale docs |
| Phase 0 | 8/10 | 7.7/10 | Public attack surface closed |
| Phase 1 | 8/10 | 8.3/10 | Regressions can't reach prod silently |
| Phase 2 | 8.5/10 | 8.6/10 | Security fixes are enforced, not just present |
| Phase 3 | 8.5/10 | 8.8/10 | Repo is legible to newcomers |
| Phase 4 | 8.5/10 | 9.2/10 | The actual product loop closes end-to-end |
| Phase 5 | 9/10 | 9.5+/10 | Scale/breadth, diminishing returns per effort |
| Phase 6 | 9/10 | 9.6+/10 | Detection is provably accurate (real caller attribution, import-aware resolution, evidence-derived confidence); the swarm's own logic has unit coverage. *If run before Phase 4 (recommended): interim Security 8.5/10, Overall 9.0/10 at that point, with Phase 4 then landing on trustworthy data instead of Phase 4's current 8.5/9.2 projection.* |
