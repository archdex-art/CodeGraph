"""Tests for the Python AST extractor and the indexing pipeline (doc 03).

Covers the invariants that matter: correct ontology extraction, FACT-grade
determinism, intra-file CALLS resolution, partial-correctness on syntax errors,
pipeline idempotency (re-index = no-op), and stable IDs across runs.
"""

import time

import pytest

from codegraph import (
    GraphStore, Kind, PythonAstExtractor, index_repo, neighbors, stable_id,
)

SAMPLE = '''\
import os
from collections import defaultdict

def helper(x):
    return x + 1

class Service:
    def run(self):
        return helper(self.value)

    def value(self):
        return 42
'''


def extract(src, path="m.py", vf=100.0):
    return PythonAstExtractor().extract(".", path, src, vf, "deadbeef")


# --- ontology -------------------------------------------------------------
def test_extracts_file_function_class_method():
    ex = extract(SAMPLE)
    types = sorted(n.type for n in ex.nodes)
    assert "File" in types
    assert types.count("Function") == 1          # helper
    assert types.count("Class") == 1             # Service
    assert types.count("Method") == 2            # run, value
    assert "Dependency" in types                 # os, collections imports

def test_all_structural_nodes_are_facts():
    ex = extract(SAMPLE)
    assert all(n.kind is Kind.FACT and n.confidence == 1.0 for n in ex.nodes)
    assert all(e.kind is Kind.FACT for e in ex.edges)

def test_function_props_capture_signature():
    ex = extract(SAMPLE)
    helper = next(n for n in ex.nodes if n.props.get("name") == "helper")
    assert helper.props["args"] == ["x"]
    assert helper.props["async"] is False

def test_defines_and_contains_edges():
    ex = extract(SAMPLE)
    rels = {e.rel for e in ex.edges}
    assert {"CONTAINS", "DEFINES", "IMPORTS"} <= rels
    # Service DEFINES run/value
    cls = next(n for n in ex.nodes if n.type == "Class")
    defines = [e for e in ex.edges if e.rel == "DEFINES" and e.src == cls.id]
    assert len(defines) == 2

def test_intra_file_calls_resolved():
    ex = extract(SAMPLE)
    # run() calls helper() -> a CALLS edge between the two symbols
    run = next(n for n in ex.nodes if n.props.get("name") == "run")
    helper = next(n for n in ex.nodes if n.props.get("name") == "helper")
    calls = [e for e in ex.edges if e.rel == "CALLS"
             and e.src == run.id and e.dst == helper.id]
    assert len(calls) == 1


# --- determinism / partial-correctness -----------------------------------
def test_deterministic_stable_ids_across_runs():
    a = extract(SAMPLE)
    b = extract(SAMPLE)
    assert sorted(n.id for n in a.nodes) == sorted(n.id for n in b.nodes)
    file_id = next(n.id for n in a.nodes if n.type == "File")
    assert file_id == stable_id("file:m.py")

def test_syntax_error_is_isolated_not_raised():
    ex = extract("def broken(:\n  pass")
    assert ex.errors and "syntax error" in ex.errors[0]
    assert ex.nodes == []   # no partial garbage from an unparseable file


# --- pipeline -------------------------------------------------------------
def test_pipeline_indexes_a_repo(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return g()\n\ndef g():\n    return 1\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.py").write_text("def h():\n    return 2\n")
    store = GraphStore()
    rep = index_repo(store, str(tmp_path), valid_from=100.0)
    assert rep.files_seen == 2
    assert rep.files_parsed == 2
    assert rep.nodes_written > 0
    # f calls g -> resolvable in a.py
    f = next(n for n in store.nodes() if n.props.get("name") == "f")
    g = next(n for n in store.nodes() if n.props.get("name") == "g")
    sg = neighbors(store, f.id, ["CALLS"], depth=1, direction="out")
    assert g.id in sg.node_ids()

def test_pipeline_is_idempotent(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    store = GraphStore()
    r1 = index_repo(store, str(tmp_path), valid_from=100.0)
    n1, e1 = r1.nodes_written, r1.edges_written
    r2 = index_repo(store, str(tmp_path), valid_from=100.0)  # same vf -> no-op
    assert r2.nodes_written == n1
    assert r2.edges_written == e1

def test_pipeline_skips_non_python(tmp_path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    (tmp_path / "README.md").write_text("# hi")
    store = GraphStore()
    rep = index_repo(store, str(tmp_path), valid_from=100.0)
    assert rep.files_seen == 1   # only the .py


# --- dogfood: index codegraph itself -------------------------------------
def test_dogfood_index_self():
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    store = GraphStore()
    rep = index_repo(store, root, valid_from=100.0)
    assert rep.files_parsed >= 5          # our own modules parse
    names = {n.props.get("name") for n in store.nodes() if n.type in ("Function", "Method")}
    assert "index_repo" in names          # found our own pipeline fn
    assert "neighbors" in names
