"""In-process bitemporal property-graph store.

Mirrors the PostgreSQL semantics of ADR-001 / 08_api_and_schema.md exactly so
the backend can be swapped for Postgres without changing the verb contract:

- Writes never mutate. Superseding a fact closes `valid_to` on the live version
  and appends a new version under the SAME logical id (a *version chain*).
- Idempotent: re-applying an identical fact (same content_hash) is a no-op.
- "As of T" returns the consistent temporal slice (at most one live version
  per logical id at any instant — the supersede invariant).

A node/edge `id` is the *logical* identity (stable across versions, e.g.
`stable_id(fqn)`); `content_hash` is the *physical* row identity used for dedupe.
This separation is what makes bitemporal versioning of the same symbol correct.
"""

from __future__ import annotations

import time
from typing import Iterable, Optional

from .envelope import Edge, Node, live_at


class GraphStore:
    def __init__(self) -> None:
        self._nodes: dict[str, list[Node]] = {}      # logical id -> version chain
        self._edges: dict[str, list[Edge]] = {}
        self._node_hashes: dict[str, str] = {}       # content_hash -> logical id
        self._edge_hashes: dict[str, str] = {}

    # --- writes -----------------------------------------------------------
    def add_node(self, node: Node) -> str:
        """Idempotent append. Returns the logical id of the stored node.

        Identical content (same content_hash) is a no-op. Otherwise the version
        is appended to the chain for `node.id`. Callers that replace a live fact
        MUST call `supersede_node` first to preserve the one-live-version invariant.
        """
        existing = self._node_hashes.get(node.content_hash)
        if existing is not None:
            return existing
        self._nodes.setdefault(node.id, []).append(node)
        self._node_hashes[node.content_hash] = node.id
        return node.id

    def add_edge(self, edge: Edge) -> str:
        if edge.src not in self._nodes or edge.dst not in self._nodes:
            raise KeyError("edge endpoints must exist")
        existing = self._edge_hashes.get(edge.content_hash)
        if existing is not None:
            return existing
        self._edges.setdefault(edge.id, []).append(edge)
        self._edge_hashes[edge.content_hash] = edge.id
        return edge.id

    def supersede_node(self, node_id: str, replacement: Optional[Node] = None,
                       at: Optional[float] = None) -> Optional[str]:
        """Close the live version at `at`; optionally append `replacement`.

        `replacement=None` just retires the fact (e.g. a deleted symbol).
        Old versions stay queryable — bitemporal history is preserved.
        """
        at = time.time() if at is None else at
        chain = self._nodes.get(node_id, [])
        for i, n in enumerate(chain):
            if n.valid_to is None:
                chain[i] = n.supersede(at)
                break
        return self.add_node(replacement) if replacement is not None else None

    def supersede_edge(self, edge_id: str, at: Optional[float] = None) -> None:
        at = time.time() if at is None else at
        chain = self._edges.get(edge_id, [])
        for i, e in enumerate(chain):
            if e.valid_to is None:
                chain[i] = e.supersede(at)
                break

    # --- reads (temporal) -------------------------------------------------
    @staticmethod
    def _live_version(chain, t: Optional[float] = None):
        if t is None:
            for item in chain:
                if item.valid_to is None:
                    return item
            return None
        for item in chain:
            if live_at(item, t):
                return item
        return None

    def get_node(self, node_id: str, as_of: Optional[float] = None) -> Optional[Node]:
        return self._live_version(self._nodes.get(node_id, []), as_of)

    def get_edge(self, edge_id: str, as_of: Optional[float] = None) -> Optional[Edge]:
        return self._live_version(self._edges.get(edge_id, []), as_of)

    def nodes(self, as_of: Optional[float] = None) -> list[Node]:
        t = time.time() if as_of is None else as_of
        return [v for chain in self._nodes.values()
                for v in chain if live_at(v, t)]

    def edges(self, as_of: Optional[float] = None) -> list[Edge]:
        t = time.time() if as_of is None else as_of
        return [v for chain in self._edges.values()
                for v in chain if live_at(v, t)]

    def history(self, node_id: Optional[str] = None) -> list[Node]:
        """All temporal versions. Scoped to one logical id when given."""
        if node_id is not None:
            return list(self._nodes.get(node_id, []))
        return [v for chain in self._nodes.values() for v in chain]

    def out_edges(self, node_id: str, rel_types: Optional[Iterable[str]] = None,
                  as_of: Optional[float] = None) -> list[Edge]:
        rels = set(rel_types) if rel_types else None
        t = time.time() if as_of is None else as_of
        return [v for chain in self._edges.values() for v in chain
                if v.src == node_id and live_at(v, t)
                and (rels is None or v.rel in rels)]

    def in_edges(self, node_id: str, rel_types: Optional[Iterable[str]] = None,
                 as_of: Optional[float] = None) -> list[Edge]:
        rels = set(rel_types) if rel_types else None
        t = time.time() if as_of is None else as_of
        return [v for chain in self._edges.values() for v in chain
                if v.dst == node_id and live_at(v, t)
                and (rels is None or v.rel in rels)]
