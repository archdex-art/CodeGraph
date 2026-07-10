# Architecture Decision Records

Chronological log of load-bearing decisions. Each ADR is immutable once `Accepted`; supersede rather than edit.

---

## ADR-001 — Graph substrate: relational bitemporal PostgreSQL
**Status:** Accepted · **Supersedes:** the multi-candidate hedge in early doc 02/06.

**Context.** Docs 02/06 originally hedged across "versioned graph store / Postgres + Apache AGE / custom FoundationDB layer." Indecision on the substrate is the single highest production risk: Apache AGE has minimal release activity and lags Postgres versions; a custom FDB graph layer is a multi-year effort.

**Decision.** Store the graph as a **relational, bitemporal property graph on plain PostgreSQL** — two tables (`nodes`, `edges`) carrying the universal fact envelope as explicit columns. Bounded traversal uses recursive CTEs. Co-locate vectors via pgvector for free graph-ID joins.

**Consequences.** (+) We own versioning, bitemporality, and content-addressing explicitly; one fewer system; trivial idempotent dedupe via `content_hash`. (−) Deep/wide traversal is slower than a native graph engine. **Exit:** migrate hot subgraphs to a managed property-graph engine (Neo4j / Memgraph / Neptune) when traversal-latency SLOs are missed; the relational schema maps cleanly onto it.

---

## ADR-002 — Vector index: pgvector first
**Status:** Accepted.

**Context.** Embeddings must join to graph node IDs for hybrid retrieval.

**Decision.** Use **pgvector** in the same Postgres instance for Phase 0–1.

**Consequences.** (+) One system; native joins to graph IDs; transactional consistency with node writes. (−) ANN recall/scale ceiling below dedicated engines. **Exit:** Qdrant when recall or scale demands, keyed by the same node IDs.

---

## ADR-003 — Event bus: NATS JetStream with mandatory DLQ + replay
**Status:** Accepted.

**Context.** The incremental pipeline reacts to deltas; a poisoned event must degrade one node, never the stream.

**Decision.** **NATS JetStream** as the backbone, shipping from day one with a **dead-letter queue, replay, and content-addressed idempotency keys** (commit + extractor).

**Consequences.** (+) Operationally lighter than Kafka; replayable. (−) Smaller ecosystem. **Exit:** Kafka only if a specific ecosystem integration requires it.

---

## ADR-004 — Orchestrator on Temporal
**Status:** Accepted.

**Context.** Doc 05's task lifecycle needs durable DAG execution, retries, and replay — hand-rolling these is error-prone.

**Decision.** Build the Orchestrator on **Temporal** durable workflows; the sub-task DAG, budgets, and escalation map directly onto Temporal primitives.

**Consequences.** (+) Durable retries/replay for free; serves doc-05 lifecycle. (−) Operational dependency. Provider-agnostic LLM calls remain activities.

---

## ADR-005 — Judge scoring reuses the health-score penalty model
**Status:** Accepted.

**Context.** Docs 04/05 promised "score vs graph-derived criteria" but gave no function; doc 07 already defines a calibrated penalty model.

**Decision.** The Judge score is `w_e·evidence + w_v·verification − w_r·risk`, where `risk` is the **doc-07 penalty** over the change's blast cone and `evidence` is noisy-OR-de-correlated `SUPPORTED_BY − CONTRADICTED_BY`. Hard-check failures score `−∞`.

**Consequences.** (+) One definition of "ground truth" across measuring and judging; removes the largest agent-loop hand-wave; calibration improvements help both surfaces. (−) Couples judge quality to health-score calibration (acceptable — both want the same calibration).

---

## ADR-006 — Belief re-derivation is budgeted and tiered
**Status:** Accepted.

**Context.** Doc 03 Stage 7 said changes "invalidate dependent beliefs, re-validated by agents." Naive agent re-validation = unbounded LLM cost on every push.

**Decision.** Tiered queue: (1) cheap deterministic recheck (does the bound commit still contain the symbol / is the contract intact) auto-resolves most invalidations for free; (2) only high-impact *ambiguous* beliefs enter a blast-radius-priority queue for **batched LLM re-validation under a token budget**.

**Consequences.** (+) Bounded cost; throughput-safe on busy monorepos. (−) Low-impact stale beliefs may linger until queried (acceptable — they carry decayed confidence).

---

## ADR-007 — Entity resolution is a scored service, never a silent merge
**Status:** Accepted.

**Context.** Symbol identity across renames/moves is the hardest correctness problem; a wrong merge permanently corrupts temporal/history queries.

**Decision.** Resolve identity with a ranked matcher (content + signature + path features). Matches **above** a confidence floor merge; matches **below** create a *new* identity plus a revisable `LIKELY_SAME_AS` BELIEF edge, with a human-review escape hatch.

**Consequences.** (+) Wrong matches are recoverable, not permanent. (−) Some duplicate identities until confirmed (visible and correctable).

---

## ADR-008 — Untrusted repo content → BELIEF-only, never capability-granting
**Status:** Accepted.

**Context.** LLM extractors read untrusted repo content (a malicious README/comment could attempt prompt injection of intent extraction).

**Decision.** Extractors operating on untrusted content run sandboxed, emit `kind=BELIEF` only, and **never** influence capability grants. Capabilities are derived solely from the PolicyKernel and FACT-grade signals.

**Consequences.** (+) Prompt injection cannot escalate privilege or forge facts. (−) Intent/doc-linking remains revisable belief (by design).
