"""Execution DAG Recorder (doc 05).

Records every model call, tool call, and decision into a content-addressed,
replayable DAG. This makes agent behavior auditable and reproducible.

Each execution node captures inputs, capabilities used, graph queries issued,
and the result. The root of the DAG is written to the graph as an ExecutionRun.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


@dataclass(frozen=True)
class ExecutionNode:
    type: str                     # 'model_call', 'tool_call', 'judge_decision'
    inputs: dict[str, Any]        # prompt, arguments, candidates
    result: Any                   # text, tool output, score
    parent_ids: list[str] = field(default_factory=list)
    model: Optional[str] = None   # if type == 'model_call'
    capabilities: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    timestamp: float = field(default_factory=time.time)

    @property
    def id(self) -> str:
        """Content-addressed ID for replayability."""
        payload = _canonical({
            "t": self.type,
            "i": self.inputs,
            "r": self.result,
            "p": self.parent_ids,
            "m": self.model,
            "c": self.capabilities,
        })
        return hashlib.sha256(payload.encode()).hexdigest()


class ExecutionDAG:
    """A mutable DAG builder during a task run."""
    def __init__(self) -> None:
        self.nodes: dict[str, ExecutionNode] = {}
        self.root_id: Optional[str] = None

    def record(self, node: ExecutionNode) -> str:
        """Idempotent record. Returns the content-addressed ID."""
        if node.id not in self.nodes:
            self.nodes[node.id] = node
        if self.root_id is None:
            self.root_id = node.id
        return node.id

    def to_dict(self) -> dict[str, Any]:
        return {
            "root_id": self.root_id,
            "nodes": {k: v.__dict__ for k, v in self.nodes.items()}
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionDAG":
        dag = cls()
        dag.root_id = data.get("root_id")
        for k, v_dict in data.get("nodes", {}).items():
            # recreate dataclass
            dag.nodes[k] = ExecutionNode(**v_dict)
        return dag
