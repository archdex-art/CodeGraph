"""Repository indexing pipeline (doc 03 stages 0–5).

Walks a repo, runs pluggable extractors per file (isolated failures), runs
repo-level extractors (ownership), then applies idempotent content-addressed
mutations to the graph store. Re-running on the same tree is a no-op (idempotent,
doc 03 Stage 4/5) — the foundation for cheap incremental updates.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

from .extractors.base import Extraction, Extractor
from .extractors.ownership import OwnershipExtractor
from .store import GraphStore


@dataclass
class IndexReport:
    files_seen: int = 0
    files_parsed: int = 0
    nodes_written: int = 0
    edges_written: int = 0
    errors: list[str] = field(default_factory=list)
    elapsed_s: float = 0.0


_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".mypy_cache"}


def index_repo(store: GraphStore, repo_root: str,
               extractors: list[Extractor] | None = None,
               valid_from: float | None = None,
               commit_sha: str | None = None) -> IndexReport:
    from .extractors.python_ast import PythonAstExtractor
    extractors = extractors or [PythonAstExtractor()]
    vf = time.time() if valid_from is None else valid_from
    rep = IndexReport()
    t0 = time.time()
    agg = Extraction()

    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for fn in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, fn), repo_root)
            handler = next((e for e in extractors if e.supports(rel)), None)
            if handler is None:
                continue
            rep.files_seen += 1
            try:
                with open(os.path.join(dirpath, fn), encoding="utf-8") as fh:
                    src = fh.read()
            except (OSError, UnicodeDecodeError) as e:
                rep.errors.append(f"{rel}: read failed: {e}")
                continue
            ext = handler.extract(repo_root, rel, src, vf, commit_sha)
            if not ext.errors:
                rep.files_parsed += 1
            agg.merge(ext)

    # repo-level: ownership (git + CODEOWNERS)
    own = OwnershipExtractor()
    agg.merge(own.extract_repo(repo_root, vf, commit_sha))

    # Stage 4/5: idempotent content-addressed apply. Nodes first (FK on edges).
    node_ids = set()
    for n in agg.nodes:
        store.add_node(n)
        node_ids.add(n.id)
    for e in agg.edges:
        # skip edges whose endpoints weren't produced (e.g. AUTHORED to a file
        # outside the indexed language set) — partial-correctness.
        if store.get_node(e.src) is None or store.get_node(e.dst) is None:
            continue
        store.add_edge(e)

    rep.nodes_written = len(store.nodes())
    rep.edges_written = len(store.edges())
    rep.errors.extend(agg.errors)
    rep.elapsed_s = time.time() - t0
    return rep
