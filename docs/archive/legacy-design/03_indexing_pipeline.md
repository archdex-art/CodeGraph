# 03 — Repository Indexing Pipeline

Goal: turn a repo (and its surrounding signals) into the knowledge graph, then keep it fresh **incrementally** and cheaply.

## Pipeline Stages

```mermaid
flowchart LR
    A[Source Event] --> B[Fetch Delta]
    B --> C[Domain Extractors]
    C --> D[Normalize + Resolve Entities]
    D --> E[Diff vs Prior Graph State]
    E --> F[Apply Graph Mutations]
    F --> G[Embed Changed Nodes]
    G --> H[Re-derive Affected Beliefs]
    H --> I[Emit Change Events to Agents]
```

### Stage 0 — Bootstrap (first index)
- Clone repo; detect languages, build system, services.
- Run all extractors over the full tree once. Parallelize per file/module.
- For large monorepos, prioritize: public APIs → hot paths (from runtime if available) → rest.

### Stage 1 — Source Events (incremental trigger)
React to deltas, never full re-scan:
- `push` / `merge` → changed files.
- `PR opened/updated` → diff + review metadata.
- `issue`/`comment` → social graph.
- CI build result → build/test/dep facts.
- Runtime exporter (OTel) → trace rollups (continuous, windowed).

### Stage 2 — Domain Extractors (pluggable)
| Extractor | Tech | Produces |
|---|---|---|
| **Code structure** | Tree-sitter (parse) + per-language semantic analyzers / LSP / `scip` indexers | Symbols, functions, types, call graph, imports |
| **Dataflow** | Language-specific IR / lightweight static analysis | `READS`/`WRITES`/`THROWS`, taint paths |
| **Architecture** | Heuristics + config parsing (Docker, k8s, service manifests) | Services, components, boundaries |
| **API/contract** | OpenAPI/proto/GraphQL parsers + route detection | Endpoints, contracts, `CONFORMS_TO` |
| **Docs/design** | Markdown/ADR parsers + LLM extraction of intent | Documents, `DESCRIBES`, `INTENDS` (BELIEF) |
| **Ownership** | CODEOWNERS + commit/review history | `OWNS`, `AUTHORED`, `REVIEWED` |
| **Dependencies** | Lockfile parsers + SCA (advisory DBs) | `DEPENDS_ON`, versions, CVEs, licenses |
| **Runtime** | OTel/eBPF trace ingestion + aggregation | `CALLS_AT_RUNTIME`, latency/error stats |
| **Social/history** | Git + tracker APIs | Commits, PRs, Issues, Incidents, links |

**Determinism rule:** structural/runtime/process extractors emit `kind=FACT, confidence=1.0`. LLM-based extractors (intent, doc→code linking) emit `kind=BELIEF` with calibrated confidence + the model/version in provenance.

### Stage 3 — Normalize + Entity Resolution
- Canonicalize to the ontology (doc 02).
- **Identity resolution:** stable IDs for symbols across renames/moves (content + signature + path heuristics, not just path); merge `Person` across email/handle aliases; align `Endpoint` to handler `Function`.
- Cross-domain linking: connect `Document`→`Function` (`DESCRIBES`), `PR`→`Issue` (`RESOLVES`), `Commit`→`Incident` (`CAUSED`), runtime span→`Function`.

### Stage 4 — Graph Diff
- Compute the minimal set of node/edge mutations vs. the prior committed graph state (versioned, not mutating).
- Content-addressed dedupe: unchanged facts get no new version.

### Stage 5 — Apply Mutations (versioned)
- Write deltas with `valid_from = commit time`; close `valid_to` on superseded versions.
- Transactional per change-set so "as of commit X" queries stay consistent.

### Stage 6 — Embedding (incremental)
- Embed only changed retrievable nodes (functions, docs, issues, ADRs).
- Store vectors keyed to graph node ID; old vectors versioned/expired.
- Use code-aware embedding models for code, general models for prose.

### Stage 7 — Belief Re-derivation
- A change invalidates dependent beliefs. Beliefs bound to a changed commit lose confidence and are queued for re-validation by agents.
- Example: a refactor of `auth.ts` invalidates the belief "TeamX owns auth logic" until re-checked.

### Stage 8 — Change Events to Agents
- Emit typed change events (`function.changed`, `contract.broken`, `cve.introduced`, `owner.unknown`) so agents can react proactively (e.g., the Security agent wakes on a new CVE edge).

---

## Incrementality & Performance
- **Unit of work = the diff**, not the repo. Most pushes touch few files → cheap updates.
- **Caching:** ASTs and extractor outputs cached by file hash; re-extract only changed files + their direct dependents (call-graph neighbors).
- **Blast-radius scoping:** a changed symbol re-derives only its dependency closure, bounded by depth.
- **Backpressure:** runtime data is high-volume → aggregate at the edge (exporter side) into windowed rollups before it hits the graph.

## Failure & Quality
- Extractors are **isolated**: a parser failure on one file degrades that node's facts, not the whole index (partial-correctness over all-or-nothing).
- **Calibration:** LLM-extractor confidence is periodically calibrated against human/verified labels; mis-calibrated extractors are down-weighted.
- **Idempotency:** re-running on the same commit produces identical graph (content-addressed) — safe retries.

## Scale Targets (design goals)
- Index a 1M-LOC repo bootstrap in minutes-to-tens-of-minutes (parallel).
- Incremental push update in seconds.
- Monorepo support via per-module sharding + lazy loading of cold subgraphs.
