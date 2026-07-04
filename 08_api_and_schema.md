# 08 — Concrete Schema & Typed-Query Contract

The buildable surface: the relational bitemporal schema (ADR-001) and the typed query verbs (doc 02) as a concrete contract. The Phase-0 reference implementation lives in `codegraph/`.

---

## Storage Schema (PostgreSQL, ADR-001)

```sql
CREATE TABLE nodes (
  id           TEXT PRIMARY KEY,                  -- ULID, sortable
  kind         TEXT NOT NULL CHECK (kind IN ('FACT','BELIEF')),
  type         TEXT NOT NULL,                     -- 'Function','Endpoint','Person',...
  props        JSONB NOT NULL DEFAULT '{}',
  confidence   REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  provenance   JSONB NOT NULL,                    -- {source, model, version, commit}
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ,                        -- NULL = currently valid
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(), -- transaction time (bitemporal)
  commit_sha   TEXT,
  content_hash TEXT NOT NULL
);
CREATE TABLE edges (
  id           TEXT PRIMARY KEY,
  rel          TEXT NOT NULL,                     -- CALLS, OWNS, DESCRIBES, ...
  src          TEXT NOT NULL REFERENCES nodes(id),
  dst          TEXT NOT NULL REFERENCES nodes(id),
  kind         TEXT NOT NULL CHECK (kind IN ('FACT','BELIEF')),
  props        JSONB NOT NULL DEFAULT '{}',
  confidence   REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  provenance   JSONB NOT NULL,
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash TEXT NOT NULL
);
CREATE INDEX idx_edges_src ON edges (src, rel);
CREATE INDEX idx_edges_dst ON edges (dst, rel);
CREATE UNIQUE INDEX uq_nodes_chash ON nodes (content_hash);
CREATE UNIQUE INDEX uq_edges_chash ON edges (content_hash);
CREATE TABLE embeddings (
  node_id  TEXT NOT NULL REFERENCES nodes(id),
  vector   vector(768) NOT NULL,                  -- pgvector
  valid_to TIMESTAMPTZ
);
```

**Bitemporal invariant.** Writes never mutate; a superseded fact gets `valid_to` closed and a new row inserted. "As of T":
```sql
WHERE valid_from <= :t AND (valid_to IS NULL OR valid_to > :t)
```

**Idempotency.** `content_hash = H(type, props, src, dst, valid_from, provenance_root)`. Re-running an extractor on the same commit produces identical hashes → `ON CONFLICT (content_hash) DO NOTHING`.

---

## Typed Query Contract

Agents and the API gateway call these verbs only — never raw SQL, never raw dumps. Each accepts an `as_of` timestamp (default = now).

| Verb | Signature | Returns |
|---|---|---|
| `get_node` | `(id, as_of?)` | node or null |
| `neighbors` | `(id, rel_types[], depth, as_of?, direction=out\|in\|both)` | bounded subgraph (nodes+edges) |
| `semantic_search` | `(query, node_types[], k, as_of?)` | ranked node IDs + scores |
| `causal_path` | `(src, dst, rel_types[], as_of?)` | ordered path or null |
| `who_owns` | `(id, as_of?)` | Person/Team nodes via `OWNS` |
| `history` | `(id)` | all temporal versions of a node |
| `conflicts` | `(claim_id)` | contradicting beliefs + confidences |

**Result envelope (every verb):**
```json
{ "as_of": "2026-06-30T00:00:00Z",
  "nodes": [ { "id": "...", "type": "...", "kind": "FACT", "confidence": 1.0, "props": {} } ],
  "edges": [ { "id": "...", "rel": "CALLS", "src": "...", "dst": "...", "confidence": 1.0 } ],
  "truncated": false }
```

**Guarantees:** bounded (`depth`/`k` capped by the Context Compiler), temporally consistent (single `as_of` slice), FACT/BELIEF tagged so callers can weight trust. `neighbors` is a recursive CTE bounded by `depth`; `semantic_search` is pgvector ANN filtered to live nodes then re-joined to the graph.

---

## Reference Implementation (Phase 0)

`codegraph/` implements this contract over an in-process store with the exact bitemporal semantics above (swap the backend for Postgres without changing the verb contract):
- `envelope.py` — the universal FACT/BELIEF envelope + ULID + content-hash.
- `store.py` — bitemporal node/edge store, idempotent upsert, `as_of` slicing, supersede-on-write.
- `retrieval.py` — `neighbors`, `semantic_search`, `causal_path`, `conflicts`.
- `tests/` — bitemporality, idempotency, FACT/BELIEF, and retrieval correctness.
