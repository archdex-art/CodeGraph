# CodeGraph

> **Own the world model of software.** A Git analyzer that continuously builds a living, temporally-consistent semantic knowledge graph of an entire codebase — code, architecture, APIs, docs, ownership, dependencies, runtime behavior, issues, PRs, design intent — and exposes it as **shared memory for a swarm of specialized AI agents** that reason, critique, judge, and iteratively improve outputs.

---

## The One-Liner
Own the world model of software, deployed as shared memory for agent swarms, and you own the layer every future dev-AI product is forced to build on.

## The Problem
Today's "AI for code" tools operate on flat file chunks + vector similarity. They have **no persistent, typed, cross-domain world model**. So agents:
- Re-discover the same context every request (expensive, lossy).
- Can't reason about *causality* (why a change breaks something downstream).
- Can't connect static structure to runtime behavior to human/process intent.
- Can't share memory or critique each other against a common ground truth.

## The Insight
A codebase is not a pile of files — it's a **graph of interrelated facts across eight domains** that evolves over time. If you fuse those domains into one queryable, confidence-weighted, temporal graph, agents stop guessing and start *reasoning*. The graph becomes:
1. **Shared memory** — agents read/write a common world model.
2. **Ground truth** — judgments are checked against the graph, not vibes.
3. **A compounding moat** — every repo indexed and every agent judgment improves schema + retrieval.

---

## Document Map

| File | Contents |
|---|---|
| [`01_architecture.md`](./01_architecture.md) | System architecture, components, data flow, deployment topology. |
| [`02_knowledge_graph_schema.md`](./02_knowledge_graph_schema.md) | Node/edge ontology, temporal + probabilistic model, storage. |
| [`03_indexing_pipeline.md`](./03_indexing_pipeline.md) | Repository ingestion, multi-domain extractors, incremental updates. |
| [`04_agent_framework.md`](./04_agent_framework.md) | Specialized agents, consensus/critique/judge loop, memory protocol. |
| [`05_execution_model.md`](./05_execution_model.md) | Task lifecycle, scheduling, verification, replay, safety. |
| [`06_roadmap_and_stack.md`](./06_roadmap_and_stack.md) | Phased roadmap, tech stack, team, risks, GTM, metrics. |
| [`07_codebase_health_score.md`](./07_codebase_health_score.md) | Graph-derived health/quality score, dimensions, error model, trends. |

## The Eight Domains Fused
1. **Code structure** — AST, symbols, types, call graph, dataflow.
2. **Architecture** — modules, services, boundaries, layering.
3. **APIs & contracts** — public interfaces, schemas, versioning.
4. **Documentation & design intent** — docs, ADRs, design docs, comments.
5. **Ownership & process** — authors, teams, CODEOWNERS, review patterns.
6. **Dependencies** — internal + external, versions, vulnerabilities, licenses.
7. **Runtime behavior** — traces, call paths, latency causality, failures.
8. **Social/history** — issues, PRs, commits, discussions, incident links.

> The defensibility is the **fusion** across these with temporal consistency — not any single extractor.

## Status
Design phase. This folder is the implementation planning artifact. Start with `01_architecture.md`.
