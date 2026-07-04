# CodeGraph — Product App

The actual product behind the marketing site's **Start Indexing** button. Paste a public Git URL → it clones the repo, builds a knowledge graph, detects issues, and computes a **Codebase Health Score** (per design doc `../07_codebase_health_score.md`).

This is a real, working slice — not a mock. The backend genuinely clones and analyzes repositories.

## Feature set (complete)
Index a **public Git URL or a local folder** → CodeGraph produces:
1. **Codebase Health Score** — 0–100, blast-radius-weighted, explainable dimensions (see `../07_codebase_health_score.md`).
2. **Three interactive visualizations** — Architecture flowchart (Blender-style nodes), zoomable Circle-pack, force-directed Network. See end of file.
3. **Code Intelligence** (`CODE_INTELLIGENCE.md`) — symbol-level knowledge graph: search, callers/callees/members, impact, circular-deps, dead-code, hubs, and a **Graph-RAG AI-context generator**.
4. **Autonomous Agent Swarm** (`AGENTS.md`) — 7 specialists analyze the graph in parallel, cross-corroborate, and a judge emits a **ranked remediation plan** with a projected Health Score. Zero external API keys required.

## Production
- **Tests:** `npm run test` (vitest, 13 unit tests over the engines).
- **Docker:** `docker compose up --build` (multi-stage, `node:24-slim`, git in runtime, non-root, persistent `data` volume, `/api/health` healthcheck).
- **Standalone build:** `output: "standalone"` → `.next/standalone/server.js`.
- **Ops + env + scaling:** see `DEPLOY.md`.

## Run it

```bash
cd CodeGraph/app
npm install        # already done if node_modules exists
npm run dev        # http://localhost:4000
```

Requires **Node ≥ 22** (uses the built-in `node:sqlite`) and **git** on PATH.

## Architecture

```
Browser (Next.js client pages)
        │  fetch
        ▼
API routes  (src/app/api/*)        ← the backend HTTP surface
        │
        ▼
Backend lib (src/lib/*)
  ├─ store.ts     job orchestration + persistence
  ├─ indexer.ts   real git clone + analysis + Health Score engine
  └─ db.ts        node:sqlite (data/codegraph.sqlite)
```

### Pages
| Route | Purpose |
|---|---|
| `/` | Start Indexing — **Git URL or local folder** (toggle), live progress, auto-redirect to report |
| `/dashboard` | All indexed repos + scores + source badge (auto-refreshes while processing) |
| `/repos/[id]` | Full report: score, graph stats, **interactive knowledge-graph visualization**, dimension breakdown, ranked issues |

### Headline features
The repo report (`/repos/[id]`) has **three switchable visualizations**, all pan/zoom + hover-interactive:
- **Architecture** (`ArchitectureView` + shared `NodeGraph`): a Blender-node-style flowchart of modules (top-level dirs; large dirs auto-expand to 2 levels) laid out in dependency tiers, wide tiers wrapped into a readable grid. Rounded-rect nodes colored by language; bezier import arrows (thickness/number = import count). Hover a node → its edges animate (flowing dashes) and connected nodes highlight while the rest dim.
- **Circle pack** (`CirclePackView`, d3-hierarchy): repo-visualizer-style nested directory circles; files are dots sized by LOC, colored by extension, issue ring. **Smooth animated zoom** (RAF-interpolated) — click a directory to fly in, click background to fly out; constant-size labels; per-extension legend.
- **Network** (`NetworkView` + shared `NodeGraph`): file-level import graph rendered as Blender-style rectangles via a force layout with **rectangle collision** (no overlap), arrows importer → imported, same hover-highlight + animated-edge behavior. Caps to the most-connected files.

The shared renderer lives in `src/components/NodeGraph.tsx` (SVG rounded-rects, border-clipped bezier edges, arrowheads, pan/zoom, hover highlight, animated flow via the `.ng-flow` keyframes in `globals.css`). Layout math is in `src/lib/layout.ts` (`forceLayout` with collision, `layeredLayout` with barycenter crossing-reduction + row wrapping); colors in `src/lib/colors.ts`.

- **Local folder indexing**: index a directory on the host machine directly (self-hosted) — no clone, nothing uploaded, read in place. Local sources are never deleted (only temp clones are cleaned up).

### API (backend)
| Endpoint | Method | Description |
|---|---|---|
| `/api/index` | POST | `{ repoUrl }` **or** `{ localPath }` → `{ jobId, repoId }` (202). Starts an async index job. |
| `/api/jobs/[id]` | GET | Job status + progress (polled by the client). |
| `/api/repos` | GET | List indexed repositories. |
| `/api/repos/[id]` | GET | Full repo detail (score, dimensions, issues, graph stats, **viz graph**). |

## What the indexer actually does (`src/lib/indexer.ts`)
1. **Clone** — shallow `git clone --depth 1` into a temp dir (90s timeout, prompts disabled).
2. **Scan** — walk the tree (skips `node_modules`, `.git`, build dirs), classify languages by extension, count LOC.
3. **Graph** — extract relative imports → build a fan-in map (graph centrality proxy); count nodes (files + dirs + deps) and edges (imports + containment).
4. **Detect issues** — heuristic rules across correctness, security, maintainability, dependency hygiene, test integrity (eval, hardcoded secrets, empty catch, SQL concat, debug output, `any`, suppressed checkers, god-files, unpinned/lockfile-less deps, missing tests…).
5. **Score** — per design doc 07:
   `penalty = Σ severity × blastRadius`, `sub_score = 100 · exp(-k · penalty / sizeFactor)`, normalized by LOC so big repos aren't unfairly punished. Overall = weighted roll-up of dimension sub-scores.
6. **Cleanup** — temp clone removed; results persisted to SQLite.

> Blast radius = `1 + fan-in` from the import graph — the differentiator from a flat lint count. An issue in a widely-imported file costs more.

## Wiring to the marketing site
The marketing site (`../website`) links **Start Indexing** here via `NEXT_PUBLIC_APP_URL`:

```bash
# CodeGraph/website/.env.local
NEXT_PUBLIC_APP_URL=http://localhost:4000   # dev
# NEXT_PUBLIC_APP_URL=https://app.codegraph.dev  # prod
```

## Limitations / next steps
This is the indexing + scoring + Health Score slice. The full design (`../04_agent_framework.md`, `../05_execution_model.md`) adds the agent swarm, sandboxed verification, replayable execution DAG, and runtime-trace fusion — not implemented here. Heuristic issue rules stand in for the full multi-language semantic + dataflow extractors described in `../03_indexing_pipeline.md`.
