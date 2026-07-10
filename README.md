# CodeGraph

> A Git analyzer that builds a knowledge graph of a codebase, computes a blast-radius-weighted **Health Score**, and runs a deterministic swarm of specialist agents that find and fix issues — grounded in the graph, not vibes.

**This is a real, working product**, not a design doc. Point it at a public repo and it clones, indexes, scores, and lets you explore and fix the codebase through three visualizations, a code-intelligence layer, an agent swarm, and a built-in editor.

## Run it
```bash
cd app
npm install
npm run dev        # http://localhost:4000
```
Requires Node ≥ 22 (uses the built-in `node:sqlite`) and `git` on PATH. Full setup, Docker, and deployment: `app/DEPLOY.md`.

## Where things live
| Path | What |
|---|---|
| [`app/`](./app) | **The actual product.** Next.js app — indexer, health score, visualizations, code intelligence, agent swarm, built-in editor. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Accurate, current system architecture — stack, request flow, security model, hard-won operational constraints. |
| [`IMPROVEMENT_PLAN.md`](./IMPROVEMENT_PLAN.md) / [`PROGRESS_TRACKER.md`](./PROGRESS_TRACKER.md) | What's being worked on next, and live status against it. |
| [`docs/postmortems/`](./docs/postmortems) | Incident write-ups for production issues found and fixed. |
| [`docs/archive/legacy-design/`](./docs/archive/legacy-design) | An earlier, more ambitious design (Python + Postgres + NATS + Temporal) that informed the current build but was never itself deployed. Historical reference only — see its own `README.md` before trusting anything in there as current. |

## The pitch (long-term direction, partially built)
Today's "AI for code" tools mostly operate on flat file chunks + vector similarity — no persistent, typed world model, so agents re-discover context every request and can't reason about causality. CodeGraph's bet: fuse a codebase's structure, dependencies, issues, and (eventually) ownership/runtime/docs into one graph, and let a swarm of specialist agents reason against that shared ground truth instead of guessing.

What's **actually built today**: code structure, dependencies, and static-issue domains, feeding a deterministic 7-agent swarm (Security/Performance/Refactor/Dead-code/Dependency/Architecture/Test) with no LLM required. Runtime behavior, ownership, and docs/design-intent domains are still ahead — see `docs/archive/legacy-design/06_roadmap_and_stack.md` for the longer-term shape, understanding that document predates and doesn't describe the current implementation.
