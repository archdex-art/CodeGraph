# CodeGraph — Code Intelligence Layer (v2)

An original, refined redesign inspired by `CodeGraph_Architecture.md` (ContinuumOS study) — **built and running**, not just designed. It upgrades CodeGraph from a *file-level* index to a *symbol-level knowledge graph* with deterministic queries and a Graph-RAG AI-context engine.

## What changed vs. the old file-level graph
| Aspect | Old (file-level) | New (symbol-level) |
|---|---|---|
| Node | file / dir | function, method, class, interface, type, enum, constant, component |
| Edges | imports, containment | `CONTAINS`, `CALLS` (resolved), imports |
| Queries | none | search, callers, callees, members, impact, cycles, dead-code, hubs |
| AI context | none | Graph-RAG: rank → expand → token-budget → structured prompt |
| Extensibility | hard-coded | pluggable `LanguageExtractor` registry |

## Architecture (Clean / DDD-layered, Hexagonal seam at the extractor)

```
scan (indexer)  ──► FileInput[]
        │
        ▼
codeintel/extractors.ts   LanguageExtractor registry  (TS/JS, Python; add langs here)
        │  RawSymbol[] + reference tokens
        ▼
codeintel/graph.ts        buildSymbolGraph()
        │  - symbol nodes (signature, doc, exported, tags, loc)
        │  - CONTAINS edges (class→method)
        │  - CALLS edges (2-pass reference resolution) + fanIn/fanOut
        │  - semantic tags (auth, db, http, ui, crypto, …)
        ▼
SymbolGraph  ──persist──►  SQLite (repos.symbols JSON, migrated)
        │
        ├─► codeintel/query.ts     QueryEngine  (deterministic graph queries, Tarjan SCC cycles)
        └─► codeintel/context.ts   buildContext (Graph-RAG prompt assembler)
                    │
                    ▼
        API: /api/repos/:id/intel?op=search|callers|callees|members|impact|cycles|deadcode|hubs|context
                    │
                    ▼
        UI: CodeIntelPanel  (search · relationship inspector · Graph-RAG generator · audits)
```

### Design principles applied
- **Open/Closed & Hexagonal:** `LanguageExtractor` is the plugin seam. Adding a language = register an extractor; graph/query/context/UI untouched. Tree-sitter/LSP can later implement the *same interface* for higher fidelity.
- **SRP / DDD bounded contexts:** `extractors` (parsing), `graph` (relationship building), `query` (retrieval), `context` (AI assembly) are separate modules.
- **KISS/YAGNI:** regex+brace/indent extraction ships today with zero native deps; no premature Neo4j/pgvector. The interfaces are ready for those upgrades without rewrites.

## Query Engine (`QueryEngine`)
Deterministic, IDE-grade answers over the symbol graph:
- `search(q)` — ranked fuzzy match on name/signature/tag/doc + centrality.
- `callers` / `callees` / `members` — direct graph edges.
- `impact(id, depth)` — transitive callers ("what breaks if I change this").
- `cycles()` — Tarjan SCC over the call graph → circular dependencies.
- `deadCode()` — functions/methods with zero resolved callers (excludes entrypoints/tests).
- `hubs()` — highest-connectivity symbols.

## Graph-RAG Context Engine (`buildContext`)
1. **Seed:** tokenize the task (drop stopwords), rank symbols per keyword.
2. **Expand:** pull callees (dependencies), top callers (usage), container + siblings, members.
3. **Budget:** greedily fill a token budget (~4 chars/token) by descending relevance, deduped.
4. **Assemble:** structured XML prompt grouped by file, each symbol tagged with its `role` (seed/callee/caller/sibling) + graph metadata — drops straight into an agent prompt.

## Verified end-to-end (express, 123 symbols)
- Index → symbol graph: **123 symbols, 94 edges, 94 resolved calls**, semantic tags.
- `search render` → ranked results; `callers` → real usage sites.
- `cycles` → 14 real call cycles (`tryRender → logerror`, `createApp → handleHeaders`).
- `deadcode` → 49 unreferenced functions.
- `context "render a view template"` → 5 seeds, 11 slices, ~647 tokens, valid structured prompt.
- UI: Code Intel tab renders search, relationship inspector, Graph-RAG generator (copy-to-clipboard), and audits.

## Roadmap (interfaces already in place)
- **M1 (done):** symbol extraction (TS/JS/Py), call graph, query engine, Graph-RAG, UI.
- **M2:** Tree-sitter extractors implementing `LanguageExtractor` for precise ranges/refs; more languages.
- **M3:** real embeddings for `search` (swap the lexical ranker) via a vector column.
  ~~Incremental per-file symbol updates~~ shipped ahead of it: `packages/analysis/src/incremental.ts`
  invalidates on content hash plus the transitive import closure, so a re-index re-extracts
  only the files a change can actually have affected.
- **M4:** feed Graph-RAG context into an autonomous agent that opens fix PRs for `deadcode`/`cycles`/top issues.
