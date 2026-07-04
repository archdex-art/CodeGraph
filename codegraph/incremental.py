"""Incremental indexing (doc 03 stages 1, 4, 5, 7).

React to a diff — changed/added/deleted files only, never a full re-scan. The
unit of work is the diff (doc 03 "Incrementality"). For each touched file we:

  1. Re-extract it (changed/added) → the desired live fact set for that file.
  2. Compute the file's *current* live fact set in the graph (attribution).
  3. Diff by content_hash: supersede facts that are gone, add facts that are new,
     leave unchanged facts untouched (bitemporal — old versions stay queryable).
  4. Queue affected BELIEFs for re-derivation (ADR-006 tiered queue; stub here).

Attribution: a file owns its `File` node (stable_id `file:<path>`) and every
symbol whose fqn starts with `<path>::`, plus edges incident to those nodes.
Shared `Dependency` nodes are never superseded per-file (other files may import
them); only the file's `IMPORTS` edges are.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

from .envelope import Edge, Kind, Node, stable_id
from .extractors.base import Extraction
from .extractors.python_ast import PythonAstExtractor
from .store import GraphStore


@dataclass
class IncrementalReport:
    changed: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    nodes_added: int = 0
    nodes_superseded: int = 0
    edges_added: int = 0
    edges_superseded: int = 0
    beliefs_requeued: int = 0
    errors: list[str] = field(default_factory=list)


def _file_owns_node(n: Node, rel_path: str) -> bool:
    if n.type == "File":
        return n.props.get("path") == rel_path
    fqn = n.props.get("fqn")
    if fqn:
        return fqn.startswith(f"{rel_path}::")
    return False  # Dependency / Person / etc. are shared, not file-owned


def apply_diff(store: GraphStore, repo_root: str,
               changed: list[str] | None = None,
               deleted: list[str] | None = None,
               at: float | None = None,
               commit_sha: str | None = None,
               extractor: PythonAstExtractor | None = None) -> IncrementalReport:
    """Apply a file-level diff to the graph bitemporally."""
    at = time.time() if at is None else at
    changed = changed or []
    deleted = deleted or []
    extractor = extractor or PythonAstExtractor()
    rep = IncrementalReport(changed=list(changed), deleted=list(deleted))

    # --- deletions: supersede everything the file owned -------------------
    for rel in deleted:
        _retire_file(store, rel, at, rep)

    # --- changes/additions: re-extract and reconcile ---------------------
    for rel in changed:
        if not extractor.supports(rel):
            continue
        abs_path = os.path.join(repo_root, rel)
        try:
            with open(abs_path, encoding="utf-8") as fh:
                src = fh.read()
        except (OSError, UnicodeDecodeError) as e:
            rep.errors.append(f"{rel}: read failed: {e}")
            continue
        ext = extractor.extract(repo_root, rel, src, at, commit_sha)
        rep.errors.extend(ext.errors)
        _reconcile_file(store, rel, ext, at, rep)

    # --- belief re-derivation (ADR-006 tiered queue: deterministic tier) --
    rep.beliefs_requeued = _requeue_beliefs(store, changed + deleted, at)
    return rep


def _live_file_facts(store: GraphStore, rel_path: str):
    """Current live nodes/edges attributed to `rel_path`."""
    nodes = [n for n in store.nodes() if _file_owns_node(n, rel_path)]
    owned_ids = {n.id for n in nodes}
    # edges owned by the file: incident to an owned node, EXCEPT shared-target
    # structural edges keep their file binding via their source being owned.
    edges = [e for e in store.edges()
             if e.src in owned_ids or e.dst in owned_ids]
    return nodes, edges


def _retire_file(store, rel_path, at, rep: IncrementalReport) -> None:
    nodes, edges = _live_file_facts(store, rel_path)
    for e in edges:
        store.supersede_edge(e.id, at)
        rep.edges_superseded += 1
    for n in nodes:
        store.supersede_node(n.id, None, at)
        rep.nodes_superseded += 1


def _reconcile_file(store, rel_path, ext: Extraction, at, rep) -> None:
    cur_nodes, cur_edges = _live_file_facts(store, rel_path)
    cur_node_hash = {n.content_hash: n for n in cur_nodes}
    cur_edge_hash = {e.content_hash: e for e in cur_edges}
    new_node_hash = {n.content_hash for n in ext.nodes}
    new_edge_hash = {e.content_hash for e in ext.edges}

    # supersede facts that no longer exist in the new extraction
    for h, n in cur_node_hash.items():
        if h not in new_node_hash:
            store.supersede_node(n.id, None, at)
            rep.nodes_superseded += 1
    for h, e in cur_edge_hash.items():
        if h not in new_edge_hash:
            store.supersede_edge(e.id, at)
            rep.edges_superseded += 1

    # add genuinely new facts (idempotent: unchanged ones dedupe to no-op)
    for n in ext.nodes:
        if n.content_hash not in cur_node_hash:
            store.add_node(n)
            if n.content_hash in new_node_hash:
                rep.nodes_added += 1
        else:
            store.add_node(n)  # no-op dedupe
    for e in ext.edges:
        if store.get_node(e.src) is None or store.get_node(e.dst) is None:
            continue
        if e.content_hash not in cur_edge_hash:
            store.add_edge(e)
            rep.edges_added += 1
        else:
            store.add_edge(e)


def _requeue_beliefs(store: GraphStore, touched_paths: list[str], at: float) -> int:
    """Deterministic tier of belief re-derivation (ADR-006).

    A BELIEF bound to a touched file/commit whose supporting node is no longer
    live loses validity and is queued (here: superseded; the LLM tier would
    re-validate high-impact ones). Returns count requeued.
    """
    requeued = 0
    live_ids = {n.id for n in store.nodes()}
    for b in [n for n in store.nodes() if n.kind is Kind.BELIEF]:
        supporting = b.props.get("supporting_node_ids", [])
        if supporting and any(sid not in live_ids for sid in supporting):
            store.supersede_node(b.id, None, at)
            requeued += 1
    return requeued
