# 02 — Knowledge Graph Schema

The graph is a **temporal, probabilistic, property graph**. Every node and edge carries metadata enabling agents to reason about *when* a fact held, *how confident* we are, and *where it came from*.

## Universal Fact Envelope
Every node and edge includes:
```
{
  id:          ULID,            // stable, sortable
  confidence:  float [0,1],     // 1.0 for parsed facts, <1 for inferred beliefs
  provenance:  Provenance,      // extractor name, commit SHA, agent id, model+version
  valid_from:  timestamp,       // when the fact became true
  valid_to:    timestamp|null,  // null = currently valid
  kind:        FACT | BELIEF,   // parsed truth vs. agent inference
  commit_sha:  string|null      // code-state binding where relevant
}
```
- **FACT** (kind=FACT, confidence=1.0): from deterministic extractors (parsers, runtime). Immutable; superseded by new versions, never edited.
- **BELIEF** (kind=BELIEF, confidence<1.0): agent-inferred (e.g., "this module owns auth"). Revisable; can be contradicted.
- **Contradiction handling:** conflicting beliefs are kept with provenance; the query planner surfaces conflicts and confidence so agents reason about disagreement instead of silently overwriting.

---

## Node Types (Ontology)

### Code domain
| Node | Key properties |
|---|---|
| `Repository` | host, default_branch, languages |
| `File` | path, language, loc, hash |
| `Module` / `Package` | name, namespace |
| `Symbol` | name, fqn (fully-qualified) |
| `Function` / `Method` | signature, complexity, async, visibility |
| `Type` / `Class` / `Interface` | fields, generics, kind |
| `Variable` / `Field` | type_ref, mutability |

### Architecture & API
| Node | Key properties |
|---|---|
| `Service` | name, language, deploy_target |
| `Component` / `Layer` | role, boundary |
| `Endpoint` | method, path, auth, schema_ref |
| `Contract` / `Schema` | format (OpenAPI/proto/GraphQL), version |

### Docs, process, runtime, social
| Node | Key properties |
|---|---|
| `Document` / `ADR` / `DesignDoc` | title, kind, embedding_ref |
| `Person` / `Team` | identity (resolved across handles) |
| `Dependency` | name, version, ecosystem, license, cves[] |
| `Issue` / `PullRequest` / `Commit` | state, title, embedding_ref |
| `Incident` | severity, started_at, resolved_at |
| `RuntimeEntity` | span/service stats (linked to code) |
| `ExecutionRun` | agent task DAG root (audit, see doc 05) |

---

## Edge Types (Relations)

### Structural (FACT)
- `CONTAINS` (Repo→File→Function), `DEFINES`, `DECLARES`
- `CALLS` (static), `REFERENCES`, `IMPORTS`, `IMPLEMENTS`, `EXTENDS`
- `HAS_TYPE`, `READS` / `WRITES` (dataflow), `THROWS`
- `EXPOSES` (Service→Endpoint), `CONFORMS_TO` (Endpoint→Contract)
- `DEPENDS_ON` (Module/Service→Dependency)

### Runtime (FACT, statistical)
- `CALLS_AT_RUNTIME` (props: count, p50/p95/p99 latency, error_rate, window)
- `EMITS` / `CONSUMES` (events/queues), `READS_FROM` / `WRITES_TO` (datastores)
- `PROPAGATES_FAILURE_TO` (inferred-causal, kind=BELIEF)

### Process & social (FACT)
- `AUTHORED`, `REVIEWED`, `OWNS` (Person/Team → code, from CODEOWNERS + history)
- `MODIFIES` (Commit/PR→File/Function), `MENTIONS`, `RESOLVES` (PR→Issue)
- `CAUSED` (Commit→Incident), `DISCUSSES` (Issue→Symbol)

### Semantic / inferred (BELIEF)
- `DESCRIBES` (Document→code, often inferred), `INTENDS` (DesignDoc→Component)
- `SIMILAR_TO` (embedding-derived), `LIKELY_OWNS`, `IS_RESPONSIBLE_FOR`
- `HYPOTHESIZES` (Agent belief → claim), `SUPPORTED_BY` / `CONTRADICTED_BY`

---

## Temporal Model
- Graph is **bitemporal**: `valid_from/valid_to` (when the fact held in the codebase) + ingestion time (when we learned it).
- Each commit produces a **delta**; nodes/edges are versioned, not mutated. Querying "as of commit X / time T" returns the consistent slice.
- Runtime edges are windowed (e.g., hourly rollups) to bound growth.

## Probabilistic / Belief Model
- Confidence propagation: derived beliefs combine source confidences. Default combiner is **noisy-OR for *independent* corroborating evidence**; when sources share provenance (same extractor/model/commit) they are de-correlated first (grouped by provenance root) so shared error is not double-counted as independent support.
- `SUPPORTED_BY` / `CONTRADICTED_BY` edges let the judge agent compute **net support** for a claim (see doc 04 for the concrete scoring function — it reuses the doc-07 penalty model).
- Beliefs decay or get re-validated as the underlying code changes (a belief bound to a stale commit loses confidence). Re-validation is **budgeted and tiered** (deterministic recheck first, LLM only for high-impact ambiguous beliefs — see doc 03 Stage 7).

---

## Retrieval Interface (for the Context Compiler)
Agents never get raw dumps. They issue **typed graph queries** + semantic search, e.g.:
- `neighbors(node, edge_types, depth, as_of)` — bounded subgraph.
- `semantic_search(query, node_kinds, k)` → graph IDs (hybrid vector+graph).
- `causal_path(from, to)` — static or runtime causal chains.
- `who_owns(node)`, `history(node)`, `contracts_touched(change_set)`.
- `conflicts(claim)` — surfaces contradicting beliefs + confidences.

## Storage Strategy (decided)
**Decision (ADR-001):** the graph is stored as a **relational, bitemporal property graph on plain PostgreSQL**, with **pgvector** for embeddings co-located for free graph-ID joins. We do **not** use Apache AGE (maintenance/version-lag risk) and we do **not** build a custom FoundationDB layer until scale metrics force it. Rationale: bitemporality, versioning, and content-addressing are explicit columns we control; bounded traversal is a recursive CTE; one fewer system to operate. **Stated scale exit:** migrate hot subgraphs to a managed property-graph engine (Neo4j / Memgraph / Neptune) when traversal latency SLOs are missed — the relational schema maps cleanly onto it.

Two tables carry the universal envelope; "as-of" is a `valid_from/valid_to` predicate:
```sql
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,        -- ULID
  kind        TEXT NOT NULL,           -- FACT | BELIEF
  type        TEXT NOT NULL,           -- 'Function', 'Endpoint', ...
  props       JSONB NOT NULL DEFAULT '{}',
  confidence  REAL NOT NULL,           -- 1.0 for FACT
  provenance  JSONB NOT NULL,          -- extractor/agent, model+version, commit
  valid_from  TIMESTAMPTZ NOT NULL,    -- when the fact held in the codebase
  valid_to    TIMESTAMPTZ,             -- NULL = currently valid
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- transaction time (bitemporal)
  commit_sha  TEXT,
  content_hash TEXT NOT NULL           -- dedupe + idempotent retries
);
CREATE TABLE edges (
  id          TEXT PRIMARY KEY,        -- ULID
  rel         TEXT NOT NULL,           -- CALLS, OWNS, DESCRIBES, ...
  src         TEXT NOT NULL REFERENCES nodes(id),
  dst         TEXT NOT NULL REFERENCES nodes(id),
  kind        TEXT NOT NULL,
  props       JSONB NOT NULL DEFAULT '{}',
  confidence  REAL NOT NULL,
  provenance  JSONB NOT NULL,
  valid_from  TIMESTAMPTZ NOT NULL,
  valid_to    TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash TEXT NOT NULL
);
CREATE INDEX ON edges (src, rel);
CREATE INDEX ON edges (dst, rel);
CREATE UNIQUE INDEX ON nodes (content_hash);   -- identical facts dedupe
CREATE UNIQUE INDEX ON edges (content_hash);
-- "as of T":  WHERE valid_from <= T AND (valid_to IS NULL OR valid_to > T)
```
- **Vectors:** pgvector column/table keyed to node `id`; old vectors versioned/expired with the node.
- **Runtime:** ClickHouse time-series; rollups materialized into windowed graph edges.
- **Provenance/audit:** `content_hash` (hash of inputs) so identical facts dedupe and runs are reproducible. Schema is **fixed for FACTs, extensible for BELIEF relation types** (agents propose new belief edge `rel` values — the self-evolving aspect).
