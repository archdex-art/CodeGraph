"""Behavioral tests for the CodeGraph Phase-0 core.

Targets the invariants that can actually break: bitemporality, idempotent
content-addressing, FACT/BELIEF rules, bounded retrieval, and the
de-correlated net-support used by the judge rubric (ADR-005).
"""

import math

import pytest

from codegraph import (
    Edge, GraphStore, Kind, Node, Provenance,
    neighbors, semantic_search, causal_path, conflicts, net_support, ulid,
)


def fn(name, vf=0.0, prov=None):
    return Node(type="Function", props={"name": name}, valid_from=vf,
                provenance=prov or Provenance("scip"))


# --- envelope ------------------------------------------------------------
def test_ulid_sortable_and_unique():
    a = ulid(now_ms=1000)
    b = ulid(now_ms=2000)
    assert a < b                      # later timestamp sorts after
    assert len({ulid() for _ in range(1000)}) == 1000

def test_fact_must_be_full_confidence():
    with pytest.raises(ValueError):
        Node(type="Function", kind=Kind.FACT, confidence=0.5)

def test_belief_allows_partial_confidence():
    n = Node(type="Claim", kind=Kind.BELIEF, confidence=0.7,
             provenance=Provenance("agent", model="gpt", version="1"))
    assert n.confidence == 0.7


# --- store: idempotency + bitemporality ----------------------------------
def test_idempotent_insert_dedupes_by_content_hash():
    s = GraphStore()
    n = fn("auth")
    id1 = s.add_node(n)
    id2 = s.add_node(fn("auth"))      # identical content -> same id, no dup
    assert id1 == id2
    assert len(s.nodes()) == 1

def test_supersede_preserves_history_and_as_of():
    s = GraphStore()
    v1 = fn("login", vf=10.0)
    s.add_node(v1)
    v2 = fn("login_v2", vf=20.0)
    s.supersede_node(v1.id, v2, at=20.0)

    # as of t=15: only v1 is live
    live15 = {n.props["name"] for n in s.nodes(as_of=15.0)}
    assert live15 == {"login"}
    # as of t=25: only v2 is live
    live25 = {n.props["name"] for n in s.nodes(as_of=25.0)}
    assert live25 == {"login_v2"}
    # history retains both
    assert len(s.history()) == 2

def test_get_node_respects_temporal_slice():
    s = GraphStore()
    n = fn("x", vf=10.0)
    s.add_node(n)
    s.supersede_node(n.id, fn("x2", vf=10.0), at=30.0)
    assert s.get_node(n.id, as_of=5.0) is None       # before valid_from
    assert s.get_node(n.id, as_of=20.0).props["name"] == "x"
    assert s.get_node(n.id, as_of=40.0) is None      # superseded by 30.0

def test_edge_requires_existing_endpoints():
    s = GraphStore()
    with pytest.raises(KeyError):
        s.add_edge(Edge(rel="CALLS", src="missing", dst="also"))


# --- retrieval: neighbors ------------------------------------------------
def build_call_graph():
    s = GraphStore()
    a, b, c, d = fn("a"), fn("b"), fn("c"), fn("d")
    for n in (a, b, c, d):
        s.add_node(n)
    s.add_edge(Edge(rel="CALLS", src=a.id, dst=b.id))
    s.add_edge(Edge(rel="CALLS", src=b.id, dst=c.id))
    s.add_edge(Edge(rel="CALLS", src=c.id, dst=d.id))
    return s, a, b, c, d

def test_neighbors_depth_bounds_subgraph():
    s, a, b, c, d = build_call_graph()
    sg1 = neighbors(s, a.id, ["CALLS"], depth=1, direction="out")
    assert sg1.node_ids() == {a.id, b.id}
    sg2 = neighbors(s, a.id, ["CALLS"], depth=2, direction="out")
    assert sg2.node_ids() == {a.id, b.id, c.id}

def test_neighbors_direction_in():
    s, a, b, c, d = build_call_graph()
    sg = neighbors(s, c.id, ["CALLS"], depth=1, direction="in")
    assert sg.node_ids() == {c.id, b.id}

def test_neighbors_max_nodes_truncates():
    s = GraphStore()
    hub = fn("hub")
    s.add_node(hub)
    for i in range(10):
        leaf = fn(f"leaf{i}")
        s.add_node(leaf)
        s.add_edge(Edge(rel="CALLS", src=hub.id, dst=leaf.id))
    sg = neighbors(s, hub.id, ["CALLS"], depth=1, direction="out", max_nodes=4)
    assert sg.truncated
    assert len(sg.nodes) <= 4

def test_neighbors_respects_as_of():
    s = GraphStore()
    a, b = fn("a", vf=0.0), fn("b", vf=0.0)
    s.add_node(a); s.add_node(b)
    e = Edge(rel="CALLS", src=a.id, dst=b.id, valid_from=0.0)
    s.add_edge(e)
    s.supersede_edge(e.id, at=50.0)
    assert neighbors(s, a.id, ["CALLS"], as_of=25.0).node_ids() == {a.id, b.id}
    assert neighbors(s, a.id, ["CALLS"], as_of=75.0).node_ids() == {a.id}


# --- retrieval: semantic_search ------------------------------------------
def test_semantic_search_ranks_by_cosine():
    s = GraphStore()
    a, b, c = fn("a"), fn("b"), fn("c")
    for n in (a, b, c):
        s.add_node(n)
    emb = {a.id: [1.0, 0.0], b.id: [0.9, 0.1], c.id: [0.0, 1.0]}
    ranked = semantic_search(s, [1.0, 0.0], emb, ["Function"], k=2)
    assert [r[0] for r in ranked] == [a.id, b.id]
    assert ranked[0][1] == pytest.approx(1.0)

def test_semantic_search_filters_by_type():
    s = GraphStore()
    f = fn("f")
    doc = Node(type="Document", props={"t": "d"})
    s.add_node(f); s.add_node(doc)
    emb = {f.id: [1.0, 0.0], doc.id: [1.0, 0.0]}
    ranked = semantic_search(s, [1.0, 0.0], emb, ["Document"], k=5)
    assert [r[0] for r in ranked] == [doc.id]


# --- retrieval: causal_path ----------------------------------------------
def test_causal_path_finds_shortest():
    s, a, b, c, d = build_call_graph()
    path = causal_path(s, a.id, d.id, ["CALLS"])
    assert path == [a.id, b.id, c.id, d.id]

def test_causal_path_unreachable_returns_none():
    s, a, b, c, d = build_call_graph()
    assert causal_path(s, d.id, a.id, ["CALLS"]) is None  # wrong direction


# --- judge rubric: de-correlated net support (ADR-005) -------------------
def test_net_support_decorrelates_shared_provenance():
    s = GraphStore()
    claim = Node(type="Claim", kind=Kind.BELIEF, confidence=0.5,
                 provenance=Provenance("agent", model="m", version="1"))
    e1 = fn("e1"); e2 = fn("e2")
    s.add_node(claim); s.add_node(e1); s.add_node(e2)
    same = Provenance("scip", version="1")  # identical root -> correlated
    s.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e1.id,
                    kind=Kind.BELIEF, confidence=0.8, provenance=same))
    s.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e2.id,
                    kind=Kind.BELIEF, confidence=0.8, provenance=same))
    # two correlated 0.8 sources must NOT exceed a single 0.8 (de-correlated)
    assert net_support(s, claim.id) == pytest.approx(0.8)

def test_net_support_independent_sources_combine():
    s = GraphStore()
    claim = Node(type="Claim", kind=Kind.BELIEF, confidence=0.5,
                 provenance=Provenance("agent", model="m", version="1"))
    e1 = fn("e1"); e2 = fn("e2")
    s.add_node(claim); s.add_node(e1); s.add_node(e2)
    s.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e1.id,
                    kind=Kind.BELIEF, confidence=0.8, provenance=Provenance("a")))
    s.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e2.id,
                    kind=Kind.BELIEF, confidence=0.8, provenance=Provenance("b")))
    # independent: 1-(0.2*0.2)=0.96
    assert net_support(s, claim.id) == pytest.approx(0.96)

def test_net_support_contradiction_subtracts():
    s = GraphStore()
    claim = Node(type="Claim", kind=Kind.BELIEF, confidence=0.5,
                 provenance=Provenance("agent", model="m", version="1"))
    e1 = fn("e1"); e2 = fn("e2")
    s.add_node(claim); s.add_node(e1); s.add_node(e2)
    s.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e1.id,
                    kind=Kind.BELIEF, confidence=0.9, provenance=Provenance("a")))
    s.add_edge(Edge(rel="CONTRADICTED_BY", src=claim.id, dst=e2.id,
                    kind=Kind.BELIEF, confidence=0.6, provenance=Provenance("b")))
    assert net_support(s, claim.id) == pytest.approx(0.9 - 0.6)
