# Coding prompt — P1: extract the seams

Paste the block below into a fresh coding session. Self-contained; assumes no prior context.
Frame generalises to other phases — swap Scope/Plan/Traps, keep the rest.

---

```
CodeGraph = a codebase workbench: git repo → symbol-level program graph → interactive views →
explainable Health Score → remediations verified against the project's own tests.
All code currently sits in `app/` (one Next.js 16 process: UI + API + analysis engine).

TASK: P1 — extract enforceable module boundaries. Structural only, zero behaviour change.

## Read first (decisions are settled; do not relitigate)
CLAUDE.md · docs/design/IDENTITY.md (BINDING) · HLD.md · LLD.md §1,§2,§8,§10,§13 ·
SPIKES.md · docs/REVIEW_2026-07-29.md
Conflict with IDENTITY.md → stop and say so.

## In scope
Create per LLD §1, move code per LLD §13:
  core-domain    types only, 0 deps, 0 I/O                      (LLD §2)
  config         typed env, fail-fast at boot                   (LLD §10.3)
  observability  structured logs; ONLY module allowed console   (HLD §14)
  fsx            capability-scoped fs; ONLY module allowed node:fs        (LLD §10.1)
  vcs            git + GitHub; ONLY module allowed child_process          (LLD §10.2)
  persistence    repositories; ONLY module allowed node:sqlite            (LLD §8)
Plus:
  - findings: JSON blob → rows + `fingerprint` column, w/ backfill migration (LLD §2.1,§8.1,§8.2)
  - ViewerId mandatory on every persistence read (LLD §8)
  - dependency-cruiser enforcing HLD §6.1 layering, wired into CI

## Out of scope — do not start
worker/job queue (P2) · detection or scoring changes (P3) · remediation/verification (P4) ·
UI refactor (components move dirs unchanged) · infra beyond the Docker fix below

## Constraints
1. Behaviour must not change. Bug found → append to REVIEW_2026-07-29.md under "Found during P1";
   do not fix here.
2. Green at every commit. Strangler-fig (LLD §13.1): create pkg → re-export from old path →
   move callers → delete shim. Never big-bang.
3. No module-level mutable state in new packages (cause of review item B4).
4. CLAUDE.md §5 invariants hold: credentials from encrypted session only; never echo raw
   exceptions to clients; repo writes require ownership + explicit action.
5. Existing tests keep passing. Relocate freely; never weaken, skip, or delete assertions.
6. Preserve why-comments when moving code — several encode outage lessons (docs/postmortems/).

## Plan — commit at each step
1. Root workspace: package.json workspaces, tsconfig.base.json (LLD §1.2), vitest.workspace.ts,
   .dependency-cruiser.cjs. Generate + COMMIT root lockfile. app/ → apps/web/. Verify build+boot.
2. core-domain: types + fingerprint(). Test fingerprint() hard — stable across line shifts,
   file moves, whitespace/literal changes.
3. config: replace every process.env read outside it + add lint ban.
4. observability: replace every console.* + add lint ban.
5. fsx: move workspace.ts; add per-access realpath containment (LLD §10.1).
6. vcs: move gitops.ts, githubApi.ts, urlSafety.ts; redactCredentials on every error path.
7. persistence: all SQL out of store.ts/db.ts; repository interfaces w/ mandatory ViewerId;
   numbered migration runner.
8. findings table + fingerprint + backfill. Verify against a COPY of a real SQLite file.
9. dependency-cruiser rules + CI job; build fails on layering violation or cycle.

## Traps — reproduced, not hypothetical (see SPIKES.md)
- outputFileTracingRoot must point at the monorepo root → entrypoint moves
  `.next/standalone/server.js` → `.next/standalone/apps/web/server.js`.
  Breaks app/Dockerfile:36 (`COPY --from=builder /app/.next/standalone ./`), :56
  (`CMD ["node","server.js"]`), and render.yaml `dockerContext: ./app`.
  FAILS AT CONTAINER START, NOT BUILD — CI build stays green while prod crash-loops.
  Fix all three; Docker smoke test gates this phase.
- `"exports": {".": "./src/index.ts"}` alone → require.resolve("pkg/package.json") throws
  ERR_PACKAGE_PATH_NOT_EXPORTED. Every manifest also needs `"./package.json": "./package.json"`.
- transpilePackages NOT needed — Turbopack compiles workspace TS directly. Add no build step.
- Cold `npm install` at workspace root never finishes; `npm ci` w/ lockfile ~23s. Commit the
  root lockfile; CI uses npm ci.
- noUncheckedIndexedAccess surfaces real bugs in fixers.ts / extractors.ts (`lines[i]`).
  Enable per package; fix properly, not with `!`.

## Done — verified by running, not asserted
[ ] npx tsc --noEmit clean, all workspaces, strict + noUncheckedIndexedAccess
[ ] npm run test — all pre-existing pass, none skipped; new tests for fingerprint(), the
    migration, and mandatory-ViewerId enforcement
[ ] npm run build → .next/standalone/apps/web/server.js exists
[ ] standalone server boots; GET /api/health → 200
[ ] npx depcruise → 0 violations, 0 cycles
[ ] Docker smoke passes at --memory=512m --cpus=0.5 --tmpfs /app/data
[ ] migration runs forward clean on a COPY of a real production SQLite file
[ ] rg "process\.env" packages apps --glob '!**/config/**'        → empty
[ ] rg "console\." packages apps --glob '!**/observability/**'    → empty
[ ] no analysis logic left under apps/web/src/app/**

## Report
1. Verification commands + actual output — paste, don't summarise.
2. File-by-file: what moved where.
3. Found but deliberately unfixed, + where recorded.
4. Deviations from the LLD, + why.
Do not describe work you did not verify. A check you couldn't run → name it and why.

## Stop and ask if
user-visible behaviour/output/scores would change · LLD and code disagree on intent · a test
would need weakening or skipping · the move requires touching detection/scoring/remediation ·
anything conflicts with IDENTITY.md
```

---

**Why it's shaped this way:** reading before code (stops re-deriving settled decisions) ·
explicit out-of-scope (scope creep is the main refactor risk) · traps as reproduced facts with
file:line (`app/Dockerfile:36` gets acted on, "watch the Dockerfile" doesn't) · every DoD box is
a command with observable output, including two `rg` calls that prove a negative ·
"do not describe work you did not verify" is the highest-value sentence in it ·
concrete escalation conditions, because "ask if unsure" yields either no questions or constant
ones.
