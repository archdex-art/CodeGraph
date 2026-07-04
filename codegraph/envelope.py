"""Universal FACT/BELIEF envelope, ULID generation, and content hashing.

Mirrors the schema in 02_knowledge_graph_schema.md / 08_api_and_schema.md.
Every node and edge carries this envelope so agents can reason about *when* a
fact held, *how confident* we are, and *where it came from*.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Optional

# --- ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32, sortable.
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid(now_ms: Optional[int] = None) -> str:
    """Generate a lexicographically-sortable 26-char ULID."""
    ts = int(time.time() * 1000) if now_ms is None else now_ms
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ts << 80) | rand
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


def stable_id(key: str) -> str:
    """Deterministic 26-char ID from a logical key (e.g. a symbol fqn).

    Used for structural FACT nodes so the same symbol yields the same id across
    re-runs — keeps edges valid and lets bitemporal supersede target the node.
    """
    digest = int.from_bytes(hashlib.sha256(key.encode()).digest()[:16], "big")
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[digest & 0x1F])
        digest >>= 5
    return "".join(reversed(chars))


class Kind(str, Enum):
    FACT = "FACT"      # deterministic extractor; confidence == 1.0; immutable
    BELIEF = "BELIEF"  # agent/LLM-inferred; confidence < 1.0; revisable


@dataclass(frozen=True)
class Provenance:
    """Where a fact came from. `root` groups correlated evidence (doc 02)."""
    source: str                       # extractor name or agent id
    model: Optional[str] = None       # model name for LLM-derived beliefs
    version: Optional[str] = None     # model/extractor version
    commit: Optional[str] = None      # code-state binding

    @property
    def root(self) -> str:
        """Correlation root: evidence sharing a root is NOT independent."""
        return f"{self.source}@{self.model or '-'}:{self.version or '-'}"

    def to_dict(self) -> dict[str, Any]:
        return {"source": self.source, "model": self.model,
                "version": self.version, "commit": self.commit}


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


@dataclass(frozen=True)
class Node:
    type: str
    props: dict[str, Any] = field(default_factory=dict)
    kind: Kind = Kind.FACT
    confidence: float = 1.0
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))
    valid_from: float = 0.0
    valid_to: Optional[float] = None
    commit_sha: Optional[str] = None
    id: str = field(default_factory=ulid)

    def __post_init__(self) -> None:
        if self.kind is Kind.FACT and self.confidence != 1.0:
            raise ValueError("FACT nodes must have confidence == 1.0")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be in [0,1]")

    @property
    def content_hash(self) -> str:
        # Time-independent: identical content at any time IS the same fact
        # (doc 03 Stage 4 — unchanged facts get no new version). Versioning is
        # via supersede, not the hash.
        payload = _canonical({"t": self.type, "p": self.props,
                              "pr": self.provenance.root})
        return hashlib.sha256(payload.encode()).hexdigest()

    def supersede(self, at: float) -> "Node":
        """Return a copy with validity closed at `at` (bitemporal supersede)."""
        return replace(self, valid_to=at)


@dataclass(frozen=True)
class Edge:
    rel: str
    src: str
    dst: str
    props: dict[str, Any] = field(default_factory=dict)
    kind: Kind = Kind.FACT
    confidence: float = 1.0
    provenance: Provenance = field(default_factory=lambda: Provenance("unknown"))
    valid_from: float = 0.0
    valid_to: Optional[float] = None
    id: str = field(default_factory=ulid)

    def __post_init__(self) -> None:
        if self.kind is Kind.FACT and self.confidence != 1.0:
            raise ValueError("FACT edges must have confidence == 1.0")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be in [0,1]")

    @property
    def content_hash(self) -> str:
        payload = _canonical({"r": self.rel, "s": self.src, "d": self.dst,
                              "p": self.props, "pr": self.provenance.root})
        return hashlib.sha256(payload.encode()).hexdigest()

    def supersede(self, at: float) -> "Edge":
        return replace(self, valid_to=at)


def live_at(item: Node | Edge, t: float) -> bool:
    """Bitemporal 'as of T' predicate (08_api_and_schema.md)."""
    return item.valid_from <= t and (item.valid_to is None or item.valid_to > t)
