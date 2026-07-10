# Legacy design docs (superseded)

Everything in this directory — `00_blueprint.md` through `08_api_and_schema.md`, `DECISIONS.md`, `PROJECT_REPORT.md`, and the `codegraph/` Python package — describes an **earlier, different architecture** that was never built out into the current product:

- A Python package (`codegraph/`) implementing a bitemporal graph store, incremental indexing pipeline, and agent-loop primitives.
- A target stack of **PostgreSQL (bitemporal graph) + pgvector + NATS JetStream + Temporal**, per `DECISIONS.md`'s ADRs.
- `PROJECT_REPORT.md` tracked that Python implementation's progress (60/60 tests passing at the time) as of 2026-06-30.

**None of this is what's actually running.** The real, current, deployed product is `app/` — a Next.js + SQLite application with a much simpler, pragmatic architecture: no Postgres, no message bus, no durable-workflow orchestrator, deterministic (non-LLM) analysis engines instead of the agent-loop design sketched here. See `../../ARCHITECTURE.md` at the repo root for the current, accurate system description, and `app/README.md` / `app/AGENTS.md` for the product-level detail.

## Why keep this around
The ideas here (bitemporal fact/belief graph, blast-radius-weighted health scoring, multi-agent critique/judge) directly informed the simpler system that got built — several of `app/`'s design choices (e.g. the health-score penalty model, the agent swarm's critic/judge structure) are deliberate, scaled-down implementations of concepts specified in these docs. Kept for historical context and as a reference for the longer-term roadmap (`06_roadmap_and_stack.md`'s later phases — runtime domain, multi-tenant platform — are still directionally relevant, just far ahead of the current build).

## What NOT to do
Don't treat any file in this directory as documentation of current behavior. If you're new to the repo, start at the root `README.md` and `ARCHITECTURE.md` instead.
