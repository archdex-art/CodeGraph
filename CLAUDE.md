# CodeGraph — working agreement

Read this before changing anything.

## 1. Identity — binding

**`docs/design/IDENTITY.md` is a binding constraint, not a style guide. Read it before writing
any design doc, README text, UI copy, or user-facing name.**

The short version:

- CodeGraph is a **codebase workbench**, not a scanner, not code search, not a linter. The graph
  is the product — everything else is a lens on it.
- Five things are ours: **the visible graph**, **the Health Score**, **the deterministic swarm**
  (specialists → critic → judge), **verified remediation** (fixes proved by running the project's
  own tests), and **the closed loop in one app**. Plus the constraint that makes them credible:
  one container, one SQLite file, no API key, MIT.
- **Technique is free; identity is not.** ASTs, CFGs, def-use chains, taint propagation with
  sources/sanitizers/sinks — all standard, use them. Another product's rule syntax, metric names,
  letter grades, category labels, or internal data model — don't take them.
- **Never position reactively.** No "X but self-hosted," no "the gap Y leaves." State what
  CodeGraph is, first and completely. Comparison comes after, if at all.
- The Health Score is the headline metric. No A–E grades, no borrowed quality badges.
- Interchange formats (e.g. SARIF) are **export adapters at the boundary**, never the internal
  `Finding` model.

If a change would make a user of another tool say *"oh, this is that product's feature"* — stop.

**Licence boundary:** adjacent projects in this space are AGPL (e.g. repowise). CodeGraph is MIT.
Learn from published methodology and cite it; **never copy, adapt, or vendor AGPL code** — it
would force CodeGraph to relicense.

## 2. Design docs

| Doc | What it settles |
|---|---|
| `docs/design/IDENTITY.md` | What CodeGraph is. Binding. |
| `docs/design/PLAN.md` | **Delivery plan — supersedes HLD §17.** Phase order, exits, prior-art ledger |
| `docs/design/HLD.md` | Target architecture, ADRs |
| `docs/design/LLD.md` | Package layout, module contracts, schema, migration map |
| `docs/design/DETECTION_ENGINE.md` | Detection research + proposed engine *(pending identity revision)* |
| `docs/design/SPIKES.md` | Monorepo + Render isolation experiments |
| `docs/REVIEW_2026-07-29.md` | Findings that motivated the above |

Design decisions live in these docs. Don't relitigate a settled ADR in a PR description.

## 3. Where things are

npm-workspaces monorepo (LLD §1). `app/` became `apps/web/` in P1.

- `apps/web/` — the Next.js application: UI, API routes, and (still) the analysis engine
- `apps/web/src/lib/` — backend: `indexer.ts`, `store.ts`, `codeintel/`, `agents/`, `gitops/`
- `apps/web/tests/` — vitest, colocated by concern
- `packages/*` — extracted, independently testable modules. `src/index.ts` is a package's
  only public surface; deep imports fail the layering gate.
- `apps/cli/`, `apps/worker/` — the CLI and the analysis worker. `apps/desktop/` (an Electron
  shell) was removed: it doubled the CI surface for a surface the deployment does not ship.
- `docs/postmortems/` — real incidents. Read before touching Docker, memory, or the data dir.

Layering is enforced, not aspirational: `.dependency-cruiser.cjs` encodes HLD §6.1 and runs in
CI. A new cross-package dependency is a deliberate edit to that file's `ALLOWED` table.

## 4. Before you push

Run what CI runs, **from the repo root** (not from `apps/web`):

```bash
npm run typecheck
npm run depcruise
npm run test
npm run build
```

All four must pass. `main` is branch-protected.

Install with `npm ci`, never `npm install` — a cold install at the workspace root does full
metadata resolution for ~500 packages and effectively hangs, and generating a lockfile against
an already-populated `node_modules` silently omits other platforms' native binaries
(REVIEW_2026-07-29 P1-3). If you must regenerate it, delete every `node_modules` first.

`npm run lint` is **not** green and is not in CI — see REVIEW_2026-07-29 P1-4 before "fixing" it.

## 5. Standing rules

- **Security-relevant code needs a regression test in the same change.** See
  `apps/web/tests/tenant-isolation.test.ts` for the expected style: real scenarios, not mocked-away
  assertions.
- **Never echo a raw exception message to a client.** Clone paths, remote URLs, and tokens leak
  that way. Log the detail, return a stable message.
- **Credentials come from the encrypted session only** — never a request body, header, or query
  parameter. `publishCredential()` in `authz.ts` is the one place that decides.
- **Anything that writes to a user's repository requires ownership**, not merely read access, and
  an explicit user action. Read access and write access are different privileges.
- **A codemod that edits source must be range-based, not line-based.** Deleting a line can change
  control flow in ways that still parse — see the brace-less-block guard in `agents/fixers.ts`.
- **Comments explain *why*, not *what*.** If a comment restates the code, delete it. If a
  non-obvious decision has a reason, write it down — especially the ones learned from an outage.
- **Don't claim in the README what the code doesn't do.** Every claim should map to a passing
  test. This project's credibility is its main asset.

## 6. Known constraints

Learned the hard way; see `docs/postmortems/` and `ARCHITECTURE.md`:

- `web-tree-sitter`'s WASM heap only grows for the process lifetime. On a 512 MB host this OOMs
  the server. (HLD ADR-001 retires this by moving analysis to a separate process.)
- The Docker container runs as **root** deliberately. Render doesn't grant `CAP_SETUID`;
  dropping privileges crash-loops it.
- A platform-mounted persistent disk is **not** a Docker named volume. Test with
  `--tmpfs /app/data:uid=0,gid=0`.
