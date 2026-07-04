"""Extractor protocol + result envelope."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from ..envelope import Edge, Node


@dataclass
class Extraction:
    """The (nodes, edges) an extractor produces, plus any per-file errors."""
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def merge(self, other: "Extraction") -> None:
        self.nodes.extend(other.nodes)
        self.edges.extend(other.edges)
        self.errors.extend(other.errors)


@runtime_checkable
class Extractor(Protocol):
    name: str

    def supports(self, path: str) -> bool:
        """Whether this extractor handles the given file path."""
        ...

    def extract(self, repo_root: str, rel_path: str, source: str,
                valid_from: float, commit_sha: str | None) -> Extraction:
        """Parse one file into graph nodes/edges. Must not raise on bad input —
        capture parse failures in `Extraction.errors` (partial-correctness)."""
        ...
