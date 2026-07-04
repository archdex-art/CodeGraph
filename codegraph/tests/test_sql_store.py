"""Backend-parity tests.

The typed retrieval verbs must behave identically whether backed by the
in-process `GraphStore` or the `SqlGraphStore` (ADR-001 swap-without-changing-
the-contract guarantee). We parametrize the core retrieval/temporal behaviors
over both backends, plus SQL-specific persistence and idempotency tests.
"""

import sqlite3

import pytest

from codegraph import (
    Edge, GraphStore, Kind, Node, Provenance, SqlGraphStore,
    neighbors, semantic_search, causal_path, net_support,
)


@pytest.fixture(params=["memory", "sql"])
def store(request):
    return GraphStore() if request.param == "memory" else SqlGraphStore()


def fn(name, vf=0.0, prov=None):
    return Node(type="Function", props={"name": name}, valid_from=vf,
                provenance=prov or Provenance("scip"))


# --- parity: idempotency + bitemporality (both backends) -----------------
def test_idempotent_dedupe(store):
    id1 = store.add_node(fn("auth"))
    id2 = store.add_node(fn("auth"))
    assert id1 == id2
    assert len(store.nodes()) == 1

def test_supersede_temporal_slice(store):
    v1 = fn("login", vf=10.0)
    store.add_node(v1)
    store.supersede_node(v1.id, fn("login_v2", vf=20.0), at=20.0)
    assert {n.props["name"] for n in store.nodes(as_of=15.0)} == {"login"}
    assert {n.props["name"] for n in store.nodes(as_of=25.0)} == {"login_v2"}
    assert len(store.history()) == 2

def test_get_node_temporal(store):
    n = fn("x", vf=10.0)
    store.add_node(n)
    store.supersede_node(n.id, fn("x2", vf=10.0), at=30.0)
    assert store.get_node(n.id, as_of=5.0) is None
    assert store.get_node(n.id, as_of=20.0).props["name"] == "x"
    assert store.get_node(n.id, as_of=40.0) is None

def test_edge_endpoints_required(store):
    with pytest.raises(KeyError):
        store.add_edge(Edge(rel="CALLS", src="missing", dst="nope"))


# --- parity: retrieval verbs (both backends) -----------------------------
def _chain(store):
    a, b, c, d = fn("a"), fn("b"), fn("c"), fn("d")
    for n in (a, b, c, d):
        store.add_node(n)
    store.add_edge(Edge(rel="CALLS", src=a.id, dst=b.id))
    store.add_edge(Edge(rel="CALLS", src=b.id, dst=c.id))
    store.add_edge(Edge(rel="CALLS", src=c.id, dst=d.id))
    return a, b, c, d

def test_neighbors_depth(store):
    a, b, c, d = _chain(store)
    assert neighbors(store, a.id, ["CALLS"], depth=1, direction="out").node_ids() == {a.id, b.id}
    assert neighbors(store, a.id, ["CALLS"], depth=2, direction="out").node_ids() == {a.id, b.id, c.id}

def test_neighbors_direction_in(store):
    a, b, c, d = _chain(store)
    assert neighbors(store, c.id, ["CALLS"], depth=1, direction="in").node_ids() == {c.id, b.id}

def test_causal_path(store):
    a, b, c, d = _chain(store)
    assert causal_path(store, a.id, d.id, ["CALLS"]) == [a.id, b.id, c.id, d.id]
    assert causal_path(store, d.id, a.id, ["CALLS"]) is None

def test_semantic_search(store):
    a, b, c = fn("a"), fn("b"), fn("c")
    for n in (a, b, c):
        store.add_node(n)
    emb = {a.id: [1.0, 0.0], b.id: [0.9, 0.1], c.id: [0.0, 1.0]}
    ranked = semantic_search(store, [1.0, 0.0], emb, ["Function"], k=2)
    assert [r[0] for r in ranked] == [a.id, b.id]

def test_net_support_decorrelated(store):
    claim = Node(type="Claim", kind=Kind.BELIEF, confidence=0.5,
                 provenance=Provenance("agent", model="m", version="1"))
    e1, e2 = fn("e1"), fn("e2")
    store.add_node(claim); store.add_node(e1); store.add_node(e2)
    same = Provenance("scip", version="1")
    store.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e1.id,
                        kind=Kind.BELIEF, confidence=0.8, provenance=same))
    store.add_edge(Edge(rel="SUPPORTED_BY", src=claim.id, dst=e2.id,
                        kind=Kind.BELIEF, confidence=0.8, provenance=same))
    assert net_support(store, claim.id) == pytest.approx(0.8)


# --- SQL-specific: real persistence across connections -------------------
def test_sql_persists_to_disk(tmp_path):
    db = tmp_path / "graph.db"
    s1 = SqlGraphStore(sqlite3.connect(db))
    n = fn("persisted")
    nid = s1.add_node(n)
    s1.add_edge(Edge(rel="CALLS", src=nid, dst=nid))  # self-edge ok for test

    # reopen: data survives, idempotency holds across processes/connections
    s2 = SqlGraphStore(sqlite3.connect(db))
    assert s2.get_node(nid) is not None
    assert s2.add_node(fn("persisted")) == nid          # content-hash dedupe
    assert len(s2.nodes()) == 1

def test_sql_round_trips_envelope_fidelity(tmp_path):
    s = SqlGraphStore(sqlite3.connect(tmp_path / "g.db"))
    prov = Provenance("scip", model="codeparser", version="2.1", commit="abc123")
    n = Node(type="Function", props={"name": "f", "complexity": 7},
             kind=Kind.BELIEF, confidence=0.42, provenance=prov,
             valid_from=5.0, commit_sha="abc123")
    s.add_node(n)
    got = s.get_node(n.id, as_of=10.0)
    assert got.kind is Kind.BELIEF
    assert got.confidence == pytest.approx(0.42)
    assert got.props == {"name": "f", "complexity": 7}
    assert got.provenance.version == "2.1"
    assert got.provenance.commit == "abc123"
    assert got.valid_to is None
