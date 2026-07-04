# CodeGraph — Project Report

**Last updated:** 2026-06-30 (session 5)
**Phase:** P0 — Core Loop (in progress)
**Health:** 🟢 On track — Core backend complete. Marketing website built.

---

## 1. Current Status (one-glance)

| Area | State | Evidence |
|---|---|---|
| Design docs (01–07) | ✅ Refined & internally consistent | docs in repo |
| Consolidated blueprint | ✅ Done | `00_blueprint.md` |
| Decision log (ADRs 001–008) | ✅ Done | `DECISIONS.md` |
| API + schema contract | ✅ Done | `08_api_and_schema.md` |
| Bitemporal graph core (version chains) | ✅ Implemented | `codegraph/store.py`, `envelope.py` |
| Typed retrieval verbs | ✅ Implemented | `codegraph/retrieval.py` |
| Test suite | ✅ 56/56 passing | `codegraph/tests/` |
| SQL backend (Postgres-portable, SQLite-tested) | ✅ Implemented & parity-tested | `codegraph/sql_store.py` |
| Code-structure extractor (Python AST + body-sig) | ✅ Implemented & tested | `codegraph/extractors/python_ast.py` |
| Ownership extractor (git + CODEOWNERS) | ✅ Implemented & tested | `codegraph/extractors/ownership.py` |
| Full indexing pipeline (doc 03 stages 0–5) | ✅ Implemented, idempotent, dogfooded | `codegraph/pipeline.py` |
| Incremental indexing (doc 03 stages 1/4/5/7) | ✅ Implemented & tested | `codegraph/incremental.py` |
| Belief re-derivation (ADR-006 deterministic tier) | ✅ Implemented; LLM tier stubbed | `codegraph/incremental.py` |
| Postgres driver wiring (psycopg) | ⬜ Deferred (no server here) | maps 1:1 from SQL backend |
| Tree-sitter extractors (other langs) | ⬜ Not started | behind `Extractor` protocol |
| Agent loop (Navigator/Refactor/Critic/Judge) | ✅ Abstractions + Termination loop | `codegraph/agents/` |
| Sandbox + execution-DAG recorder | ✅ Execution DAG | `codegraph/execution.py` |

---
## 2. Done (latest session: Website Generation)
- Generated a sleek, dark-themed marketing landing page in `website/` using **Next.js 15**, **Tailwind CSS**, **Framer Motion**, and **Lucide React**.
- Implemented smooth entrance animations and glowing elements tailored to the CodeGraph "developer tool" aesthetic.

<details><summary>Earlier sessions (Agent Loop, review, core, SQL, extractors, incremental)</summary>

**s5 — Agent Loop & Execution DAG:**
- `execution.py` — `ExecutionDAG` and `ExecutionNode`: content-addressable record of every model/tool call for replayable audit (doc 05).
- `agents/loop.py` — `Candidate`, `evaluate_candidate`, `critique_and_judge_loop`: Implements the concrete Judge scoring rubric from ADR-005 (evidence + verification - risk) and enforces termination guarantees (max rounds, tie-breaks, escalation).
- `tests/test_agents.py` — Verifies DAG content-addressing round-trips, Judge scoring math, and Orchestrator loop termination/escalation limits.

<details><summary>Earlier sessions (review, core, SQL, extractors, incremental)</summary>

**s4 — version chains + incremental index:**
- **Version chains**: Refactored `GraphStore` and `SqlGraphStore` (schema migrated to logical `id` + physical `content_hash` PK) so a logical ID holds its full bitemporal history.
- `envelope.py`: Dropped `valid_from` from `content_hash` (content addressing is now truly time-independent, doc 03 Stage 4 dedupe). Added `body_sig` to function props to detect body-only changes.
- `incremental.py` — `apply_diff()`: Incrementally supersedes deleted files' facts, re-extracts changed files and reconciles their live subgraph (diffing hashes to add/supersede). Implements ADR-006 deterministic belief re-derivation (retires beliefs whose supporting facts disappear).
- `test_incremental.py`: 7 tests proving incremental properties — untouched files untouched, removed symbols bitemporally superseded, old call-graph edges closed, and history preserved under "as of" queries.
<details><summary>Earlier sessions (review, refinement, core, SQL, pipeline)</summary>

**s3 — pipeline + extractors:**
- `extractors/base.py` — `Extractor` protocol + `Extraction` envelope; pluggable, isolated-failure design (other languages drop in behind it).
- `extractors/python_ast.py` — `PythonAstExtractor`: FACT-grade code structure via stdlib `ast` (File/Function/Class/Method + CONTAINS/DEFINES/IMPORTS/CALLS with intra-file call resolution; stable IDs for cross-run dedupe).
- `extractors/ownership.py` — `OwnershipExtractor`: Person (by email) + AUTHORED from git history; OWNS/Team/PathGlob from CODEOWNERS.
- `pipeline.py` — `index_repo`: walks tree, runs extractors (isolated), applies idempotent content-addressed mutations (doc 03 stages 0–5). Re-index = no-op.
- `tests/test_extractors.py` — 11 tests incl. ontology, FACT determinism, CALLS resolution, syntax-error isolation, idempotency, and **dogfooding** (indexes `codegraph/` itself).
- Demo: indexed our own 14 files → 162 nodes / 259 edges in ~18 ms; ownership verified on a real git repo (AUTHORED + OWNS, zero errors).
- Added `stable_id()` to `envelope.py` for deterministic structural-node identity.

<details><summary>Earlier sessions (review, refinement, core, SQL backend)</summary>

**s2 — SQL backend:** `SqlGraphStore` (Postgres-portable, SQLite-tested) + 20 parity/persistence tests; retrieval verbs backend-swappable unchanged (ADR-001).

**s1 — review + core:**

**Doc refinements (clear-improvement rewrites):**
- README: unified domain count to **eight**.
- 02: decided substrate (relational bitemporal Postgres + pgvector) with concrete DDL; noisy-OR independence caveat; tiered re-derivation pointer.
- 04: concrete judge scoring function (reuses doc-07 penalty model) + loop termination guarantees; removed "Oh-My-Pie" orphan term.
- 06: graph store/event-bus/orchestrator decisions; AGE risk flagged; "MergeMind" removed; team-vs-spike contradiction fixed; substrate-risk row added.
- 07: defined `k` (= ln 2) and `penalty_ref` normalization.
- 01: added 5th **API & Control plane** to topology + component breakdown.

**New artifacts:**
- `00_blueprint.md` — single decided design (5 planes, stack, request path, gated roadmap).
- `DECISIONS.md` — ADR-001..008.
- `08_api_and_schema.md` — schema + typed-query contract.

**Implementation (`codegraph/`, zero-dependency stdlib):**
- `envelope.py` — FACT/BELIEF envelope, ULID, content-hash, bitemporal `live_at`.
- `store.py` — idempotent content-addressed upsert, supersede-on-write, `as_of` slicing.
- `retrieval.py` — `neighbors`, `semantic_search`, `causal_path`, `conflicts`, `net_support` (provenance-de-correlated noisy-OR).
- `tests/test_core.py` — 18 tests, all green.
</details>

---

## 4. Next Up (priority order)

**Critical (P0 exit gate):**
1. Tree-sitter extractor for a second language (TS) behind the `Extractor` protocol.
2. Sandbox tool capabilities (mock Firecracker / local execution) to feed the `verification_passed` property.
3. Wire psycopg to point `SqlGraphStore` at a real Postgres (1:1 from current SQL; deferred — no server in this env).

**P0 exit gate (measurable):** verified PR on a real OSS repo; byte-identical replay; 100k-LOC bootstrap < 10 min.

---

## 5. Open Risks / Decisions Pending
- Embedding model choice (code-aware + general) — deferred until extractors land.
- Benchmark harness to validate the "minutes / seconds" perf goals (currently labelled *design goal, unvalidated* in `00_blueprint.md`).
- Multi-tenancy vs. shared-learning governance boundary — to be resolved before any cross-tenant calibration.

---

## 6. Test / Verification Log
| Date | What ran | Result |
|---|---|---|
| 2026-06-30 (s1) | `pytest codegraph/tests/` | 18 passed |
| 2026-06-30 (s5) | `pytest codegraph/tests/` (all) | 60 passed |
| 2026-06-30 (s4) | custom incremental script (body change detection) | OK |
| 2026-06-30 (s1) | end-to-end smoke (`neighbors` over EXPOSES) | OK |
| 2026-06-30 (s2) | `pytest codegraph/tests/` (both backends) | 38 passed |
| 2026-06-30 (s2) | cross-backend smoke (memory + SQL) | OK |
| 2026-06-30 (s3) | `pytest codegraph/tests/` (core+sql+extractors) | 49 passed |
| 2026-06-30 (s3) | dogfood index of `codegraph/` (14 files → 162 nodes/259 edges, 18ms) | OK |
| 2026-06-30 (s3) | ownership on a real git repo (AUTHORED + OWNS) | OK, 0 errors |
| 2026-06-30 (s6) | `npm run build` inside `website/` | OK |
---

## 7. Changelog
- **2026-06-30** — Repository review (9 phases) delivered; doc refinements applied; `00_blueprint.md`, `DECISIONS.md`, `08_api_and_schema.md` added; Phase-0 graph core implemented and tested (18/18). This report created.
- **2026-06-30 (s2)** — Added `SqlGraphStore` (Postgres-portable SQL backend) + 20 parity/persistence tests; full suite 38/38. Confirmed retrieval verbs are backend-swappable without modification.
- **2026-06-30 (s3)** — Added pluggable extractor framework (`Extractor` protocol), `PythonAstExtractor` (FACT-grade code structure), `OwnershipExtractor` (git + CODEOWNERS), and `index_repo` pipeline (idempotent, doc 03 stages 0–5) + 11 tests incl. dogfooding. Full suite 49/49. Added `stable_id()` for deterministic node identity.
- **2026-06-30 (s4)** — Implemented incremental indexing (`incremental.py`). Refactored stores to true version chains (logical `id` -> list of versions). Removed `valid_from` from content hashes to fix dedupe. Full suite 56/56.
- **2026-06-30 (s5)** — Implemented `ExecutionDAG` for replayable auditing and the `critique_and_judge_loop` primitives, finalizing the ADR-005 scoring math and termination guarantees. Full suite 60/60.
- **2026-06-30 (s6)** — Built a beautiful animated landing page using Next.js, Framer Motion, and Tailwind CSS in the `website/` directory.
