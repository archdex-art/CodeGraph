# 06 — Roadmap, Stack, Risks & GTM

## Phased Roadmap

### Phase 0 — Spike (0–2 months)
**Prove the core loop on one language, one repo.**
- Tree-sitter + one semantic indexer (e.g., `scip` for TS or Python).
- Minimal graph: code + ownership + PR/issue domains only.
- Hybrid retrieval (graph traversal + vectors).
- 2 specialists (Navigator + Refactor) + Critic + Judge over the graph.
- Deliverable: agent answers "where/why" questions and opens a verified PR on a real repo, with a replayable run.

### Phase 1 — Vertical Slice / Wedge (2–6 months)
**Pick ONE killer use case to monetize.** Recommended wedge: **autonomous dependency upgrades + breaking-change analysis** (clear value, verifiable, bounded blast radius).
- Add dependency + contract + test extractors.
- Full critique/judge/verify loop with sandbox + capability policy.
- Execution DAG recorder + replay.
- Self-hosted/VPC deployment option (enterprise requirement).
- Deliverable: design partners running autonomous dep upgrades with green-CI auto-merge.

### Phase 2 — Multi-domain Graph + Runtime (6–12 months)
- Add architecture, docs/design-intent, and **runtime** extractors (OTel ingestion → `CALLS_AT_RUNTIME`).
- Expand specialist roster (Security, Performance, Architect).
- Belief re-derivation + temporal queries hardened at scale.
- Deliverable: "Why is X slow / why did Y break" answered with causal evidence.

### Phase 3 — Platform (12–24 months)
- Public typed query + agent API; third-party specialists.
- Cross-repo / org-wide reasoning (consumes the graph for fleet-scale tasks across an org's entire repository portfolio).
- Marketplace of specialists + shared (anonymized) execution-trace format.
- Deliverable: CodeGraph as the substrate other dev-AI products build on.

---

## Technology Stack (candidate choices)

| Layer | Candidates | Notes |
|---|---|---|
| **Parsing** | Tree-sitter, LSP servers, `scip`/SCIP indexers | Per-language; start with TS + Python |
| **Static analysis** | Language IRs, CodeQL-style queries (own engine long-term) | Dataflow/taint |
| **Graph store** | **PostgreSQL (relational bitemporal graph)** → managed property-graph engine (Neo4j/Memgraph/Neptune) at scale | Decided (ADR-001). **Not** Apache AGE (maintenance/version-lag risk); **not** custom FoundationDB until metrics force it. Bitemporality/versioning are explicit columns. |
| **Vector index** | Qdrant / LanceDB / pgvector (start) | Keyed to graph node IDs |
| **Runtime ingest** | OpenTelemetry, eBPF (Pixie-style) | Edge aggregation before graph |
| **Time-series** | ClickHouse | Trace rollups |
| **Event bus** | **NATS JetStream** (start) → Kafka if ecosystem needed | Incremental pipeline backbone. **Must** ship with DLQ + replay + idempotency keys. |
| **Sandbox** | Firecracker microVMs / gVisor / WASM | Capability-scoped execution |
| **Agent runtime** | Custom orchestrator on **Temporal** (durable task DAG/retries/replay), tiered LLMs | Provider-agnostic; Temporal serves doc-05 lifecycle directly |
| **Embeddings** | Code-aware + general models | Incremental, cached |

> Bias to boring/proven infra early (plain PostgreSQL bitemporal graph + pgvector); earn the right to build custom graph/vector engines only when scale demands it.

---

## Team (target by end of Phase 1; Phase 0 spike is 1–2 founders/eng)
- **Compiler/static-analysis engineer** (graph extraction quality = the moat).
- **Distributed-systems engineer** (incremental pipeline, temporal graph at scale).
- **ML/agent engineer** (orchestration, critique/judge, calibration).
- **Runtime/observability engineer** (OTel/eBPF ingestion).
- **Founding DevRel/forward-deployed** (design partners, VPC installs).
- Founders cover product + GTM.

## Key Risks & Mitigations
| Risk | Mitigation |
|---|---|
| **Scope explosion** (8 domains at once) | Phase gating: 3 domains → wedge → expand. Never boil the ocean. |
| **Graph quality / hallucinated beliefs** | FACT vs BELIEF separation; confidence calibration; verification gates. |
| **Enterprise won't ship code out** | VPC/self-hosted from Phase 1; no code in shared models. |
| **Incumbents (GitHub/Cursor) add graphs** | They're file-centric + innovator's dilemma; we go agent-first + multi-domain + runtime fusion they can't easily retrofit. |
| **Cost of indexing + agents** | Incremental everything; tiered models; context compiler; caching/replay. |
| **Trust to act autonomously** | Autonomy levels, blast-radius governor, replayable audit, rollback. |
| **Cold start per repo** | Bootstrap value from day 1 (search/Q&A) before autonomous actions. |
| **Graph substrate bet** (engine lock-in/maintenance) | Relational bitemporal Postgres now (we own versioning); managed property-graph engine as a stated, schema-compatible exit (ADR-001). No Apache AGE, no premature custom FDB layer. |

## Go-To-Market
- **Wedge:** autonomous dependency upgrades / breaking-change analysis (Phase 1) — quantifiable ROI (engineer-hours saved), low trust barrier (bounded, verifiable).
- **Motion:** design partners (5–10 mid-size eng orgs) → VPC deploys → land-and-expand into security/perf/refactor as graph deepens.
- **Pricing:** per-seat + usage (indexed LOC + agent task volume); enterprise self-hosted tier.
- **Expansion:** each new domain/specialist = new upsell on the same graph.

## North-Star & Metrics
- **North star:** verified autonomous changes merged / week (proof the loop works and is trusted).
- **Leading indicators:** graph coverage %, retrieval precision, judge-vs-human agreement, % tasks passing verification first try, mean blast radius, replay fidelity.
- **Moat metric:** belief-quality + judge-calibration improvement per repo over time (does the swarm get smarter with use?).

---

## What to Build First (this week)
1. Stand up PostgreSQL (bitemporal graph schema, ADR-001) + pgvector; define the FACT subset of the ontology (doc 02).
2. Tree-sitter + scip indexer for one language → populate code + ownership + PR domains.
3. Implement `neighbors` / `semantic_search` retrieval.
4. Wire Navigator + Refactor + Critic + Judge with a tiered LLM backend.
5. Sandbox + run-tests capability + execution DAG recorder.
6. Demo: "open a verified PR fixing X" on a real repo, fully replayable.
