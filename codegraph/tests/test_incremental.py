"""Incremental indexing tests (doc 03 stages 1/4/5/7).

The defining property: a diff updates only touched files, supersedes changed
facts bitemporally (old versions stay queryable "as of" the old time), and
leaves untouched facts alone. Also verifies version chains preserve history.
"""

import pytest

from codegraph import (
    Edge, GraphStore, Kind, Node, Provenance, SqlGraphStore,
    apply_diff, index_repo, neighbors, stable_id,
)
import sqlite3


@pytest.fixture(params=["memory", "sql"])
def store(request):
    return GraphStore() if request.param == "memory" else SqlGraphStore(
        sqlite3.connect(":memory:"))


# --- version chains preserve history (store-level) -----------------------
def test_supersede_preserves_chain_history(store):
    n = Node(id=stable_id("sym:x"), type="Function",
             props={"name": "x", "fqn": "m.py::x", "lineno": 1}, valid_from=10.0,
             provenance=Provenance("scip"))
    store.add_node(n)
    n2 = Node(id=stable_id("sym:x"), type="Function",
              props={"name": "x", "fqn": "m.py::x", "lineno": 5}, valid_from=20.0,
              provenance=Provenance("scip"))
    store.supersede_node(n.id, n2, at=20.0)
    # as-of the old window: the lineno-1 version is live
    assert store.get_node(n.id, as_of=15.0).props["lineno"] == 1
    # as-of the new window: the lineno-5 version is live
    assert store.get_node(n.id, as_of=25.0).props["lineno"] == 5
    # both versions retained in history under one logical id
    assert len(store.history(n.id)) == 2
    # exactly one live version at any instant
    assert len([x for x in store.nodes(as_of=25.0) if x.id == n.id]) == 1


# --- incremental: changed file ------------------------------------------
def _write(tmp_path, name, body):
    p = tmp_path / name
    p.write_text(body)
    return name


def test_changed_file_supersedes_removed_symbol(tmp_path):
    store = GraphStore()
    _write(tmp_path, "a.py", "def f():\n    return 1\n\ndef g():\n    return 2\n")
    index_repo(store, str(tmp_path), valid_from=100.0)
    assert {n.props["name"] for n in store.nodes() if n.type == "Function"} == {"f", "g"}

    # g removed, f kept, h added
    _write(tmp_path, "a.py", "def f():\n    return 1\n\ndef h():\n    return 3\n")
    rep = apply_diff(store, str(tmp_path), changed=["a.py"], at=200.0)

    live = {n.props["name"] for n in store.nodes() if n.type == "Function"}
    assert live == {"f", "h"}                 # g superseded, h added
    assert rep.nodes_superseded >= 1
    assert rep.nodes_added >= 1
    # history: g still queryable as of the old time
    old = {n.props["name"] for n in store.nodes(as_of=150.0) if n.type == "Function"}
    assert old == {"f", "g"}

def test_unchanged_symbol_not_superseded(tmp_path):
    store = GraphStore()
    _write(tmp_path, "a.py", "def f():\n    return 1\n\ndef g():\n    return 2\n")
    index_repo(store, str(tmp_path), valid_from=100.0)
    f_before = store.get_node(stable_id("sym:a.py::f"))

    _write(tmp_path, "a.py", "def f():\n    return 1\n\ndef g():\n    return 99\n")
    apply_diff(store, str(tmp_path), changed=["a.py"], at=200.0)

    f_after = store.get_node(stable_id("sym:a.py::f"))
    # f is byte-identical -> same content_hash -> not a new version
    assert f_after.content_hash == f_before.content_hash
    assert len(store.history(stable_id("sym:a.py::f"))) == 1

def test_deleted_file_retires_all_its_facts(tmp_path):
    store = GraphStore()
    _write(tmp_path, "a.py", "def f():\n    return g()\n\ndef g():\n    return 1\n")
    _write(tmp_path, "b.py", "def keep():\n    return 1\n")
    index_repo(store, str(tmp_path), valid_from=100.0)

    rep = apply_diff(store, str(tmp_path), deleted=["a.py"], at=200.0)
    live_files = {n.props.get("path") for n in store.nodes() if n.type == "File"}
    assert live_files == {"b.py"}             # a.py retired, b.py kept
    assert rep.nodes_superseded >= 3          # File + f + g
    # b.py untouched
    assert store.get_node(stable_id("sym:b.py::keep")) is not None
    # a.py's call graph still queryable as of old time
    old_files = {n.props.get("path") for n in store.nodes(as_of=150.0) if n.type == "File"}
    assert old_files == {"a.py", "b.py"}

def test_changed_call_edge_updates(tmp_path):
    store = GraphStore()
    _write(tmp_path, "a.py", "def f():\n    return g()\n\ndef g():\n    return 1\n")
    index_repo(store, str(tmp_path), valid_from=100.0)
    f_id = stable_id("sym:a.py::f")
    assert any(e.rel == "CALLS" for e in store.out_edges(f_id))

    # f no longer calls g
    _write(tmp_path, "a.py", "def f():\n    return 0\n\ndef g():\n    return 1\n")
    apply_diff(store, str(tmp_path), changed=["a.py"], at=200.0)
    assert not any(e.rel == "CALLS" for e in store.out_edges(f_id, as_of=250.0))
    # but the old CALLS edge is still there as of the old time
    assert any(e.rel == "CALLS" for e in store.out_edges(f_id, as_of=150.0))


# --- belief re-derivation (ADR-006 deterministic tier) -------------------
def test_belief_requeued_when_support_retired(tmp_path):
    store = GraphStore()
    _write(tmp_path, "a.py", "def auth():\n    return 1\n")
    index_repo(store, str(tmp_path), valid_from=100.0)
    auth_id = stable_id("sym:a.py::auth")

    # an agent belief supported by auth()
    belief = Node(type="Claim", kind=Kind.BELIEF, confidence=0.7,
                  props={"claim": "TeamX owns auth",
                         "supporting_node_ids": [auth_id]},
                  provenance=Provenance("agent", model="m", version="1"),
                  valid_from=100.0)
    store.add_node(belief)

    # auth() removed -> its node retired -> belief loses support -> requeued
    _write(tmp_path, "a.py", "def other():\n    return 2\n")
    rep = apply_diff(store, str(tmp_path), changed=["a.py"], at=200.0)
    assert rep.beliefs_requeued == 1
    assert store.get_node(belief.id, as_of=250.0) is None      # retired
    assert store.get_node(belief.id, as_of=150.0) is not None  # history kept
