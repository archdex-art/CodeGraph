"""Typed retrieval verbs (08_api_and_schema.md).

Agents call these — never raw dumps. Every verb is bounded and temporally
consistent (single `as_of` slice). `semantic_search` uses cosine over embedding
vectors held alongside nodes; in production this is pgvector ANN re-joined to
the graph (the verb contract is identical).
"""

from __future__ import annotations

import math
from collections import deque
from typing import Optional

from .envelope import Edge, Node
from .store import GraphStore


class Subgraph:
    def __init__(self, nodes: list[Node], edges: list[Edge],
                 as_of: Optional[float], truncated: bool = False) -> None:
        self.nodes = nodes
        self.edges = edges
        self.as_of = as_of
        self.truncated = truncated

    def node_ids(self) -> set[str]:
        return {n.id for n in self.nodes}


def neighbors(store: GraphStore, node_id: str, rel_types: Optional[list[str]] = None,
              depth: int = 1, as_of: Optional[float] = None,
              direction: str = "both", max_nodes: int = 256) -> Subgraph:
    """Bounded BFS subgraph. `depth` and `max_nodes` cap the blast radius."""
    if direction not in ("out", "in", "both"):
        raise ValueError("direction must be out|in|both")
    root = store.get_node(node_id, as_of)
    if root is None:
        return Subgraph([], [], as_of)

    seen_nodes: dict[str, Node] = {root.id: root}
    seen_edges: dict[str, Edge] = {}
    frontier: deque[tuple[str, int]] = deque([(node_id, 0)])
    truncated = False

    while frontier:
        cur, d = frontier.popleft()
        if d >= depth:
            continue
        edges: list[Edge] = []
        if direction in ("out", "both"):
            edges += store.out_edges(cur, rel_types, as_of)
        if direction in ("in", "both"):
            edges += store.in_edges(cur, rel_types, as_of)
        for e in edges:
            seen_edges[e.id] = e
            nxt = e.dst if e.src == cur else e.src
            if nxt not in seen_nodes:
                n = store.get_node(nxt, as_of)
                if n is None:
                    continue
                if len(seen_nodes) >= max_nodes:
                    truncated = True
                    continue
                seen_nodes[nxt] = n
                frontier.append((nxt, d + 1))

    return Subgraph(list(seen_nodes.values()), list(seen_edges.values()),
                    as_of, truncated)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def semantic_search(store: GraphStore, query_vec: list[float],
                    embeddings: dict[str, list[float]],
                    node_types: Optional[list[str]] = None, k: int = 5,
                    as_of: Optional[float] = None) -> list[tuple[str, float]]:
    """Rank live nodes by cosine to `query_vec`. Returns (node_id, score) desc."""
    types = set(node_types) if node_types else None
    scored: list[tuple[str, float]] = []
    for n in store.nodes(as_of):
        if types is not None and n.type not in types:
            continue
        vec = embeddings.get(n.id)
        if vec is None:
            continue
        scored.append((n.id, _cosine(query_vec, vec)))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]


def causal_path(store: GraphStore, src: str, dst: str,
                rel_types: Optional[list[str]] = None,
                as_of: Optional[float] = None,
                max_depth: int = 16) -> Optional[list[str]]:
    """Shortest directed path src->dst over `rel_types`. None if unreachable."""
    if store.get_node(src, as_of) is None or store.get_node(dst, as_of) is None:
        return None
    prev: dict[str, str] = {src: src}
    frontier: deque[tuple[str, int]] = deque([(src, 0)])
    while frontier:
        cur, d = frontier.popleft()
        if cur == dst:
            path = [dst]
            while path[-1] != src:
                path.append(prev[path[-1]])
            return list(reversed(path))
        if d >= max_depth:
            continue
        for e in store.out_edges(cur, rel_types, as_of):
            if e.dst not in prev:
                prev[e.dst] = cur
                frontier.append((e.dst, d + 1))
    return None


def conflicts(store: GraphStore, claim_id: str,
              as_of: Optional[float] = None) -> dict[str, list[Edge]]:
    """Surface SUPPORTED_BY / CONTRADICTED_BY evidence for a claim node."""
    out = store.out_edges(claim_id, ["SUPPORTED_BY", "CONTRADICTED_BY"], as_of)
    return {
        "supported_by": [e for e in out if e.rel == "SUPPORTED_BY"],
        "contradicted_by": [e for e in out if e.rel == "CONTRADICTED_BY"],
    }


def net_support(store: GraphStore, claim_id: str,
                as_of: Optional[float] = None) -> float:
    """Noisy-OR-de-correlated evidence score (ADR-005 / doc 04 judge rubric).

    Groups evidence by provenance root so shared-error sources are not
    double-counted as independent support, then noisy-OR within sign.
    """
    ev = conflicts(store, claim_id, as_of)

    def grouped_noisy_or(edges: list[Edge]) -> float:
        by_root: dict[str, float] = {}
        for e in edges:
            r = e.provenance.root
            by_root[r] = max(by_root.get(r, 0.0), e.confidence)  # de-correlate
        prod = 1.0
        for c in by_root.values():
            prod *= (1.0 - c)
        return 1.0 - prod

    return grouped_noisy_or(ev["supported_by"]) - grouped_noisy_or(ev["contradicted_by"])
