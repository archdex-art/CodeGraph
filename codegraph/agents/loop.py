"""Agent loop primitives: Judge scoring and Orchestrator termination guarantees.

Implements the concrete scoring rubric from ADR-005 and doc 07, ensuring the
swarm terminates predictably without infinite loops.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

from ..envelope import Edge, Kind, Node, Provenance, stable_id
from ..retrieval import net_support
from ..store import GraphStore
from ..execution import ExecutionDAG, ExecutionNode


@dataclass
class Candidate:
    """A proposed solution from a specialist agent."""
    text: str
    proposed_beliefs: list[Node] = field(default_factory=list)
    proposed_edges: list[Edge] = field(default_factory=list)
    # the ID of the primary claim node representing this solution's validity
    claim_id: Optional[str] = None
    verification_passed: float = 0.0  # fraction of sandbox checks passed [0,1]
    hard_check_failed: bool = False   # e.g., compilation failed
    risk_penalty: float = 0.0         # computed via doc-07 formula


def evaluate_candidate(store: GraphStore, candidate: Candidate,
                       w_e: float = 0.4, w_v: float = 0.4, w_r: float = 0.2,
                       as_of: Optional[float] = None) -> float:
    """Judge scoring rubric (ADR-005).

    score = w_e * evidence + w_v * verification - w_r * risk
    If a hard check failed, score is -inf.
    """
    if candidate.hard_check_failed:
        return -math.inf

    evidence = 0.0
    if candidate.claim_id:
        evidence = net_support(store, candidate.claim_id, as_of)

    return (w_e * evidence) + (w_v * candidate.verification_passed) - (w_r * candidate.risk_penalty)


@dataclass
class LoopResult:
    winner: Optional[Candidate]
    escalated: bool
    reason: str
    rounds_run: int
    dag: ExecutionDAG


def critique_and_judge_loop(store: GraphStore, 
                            task_prompt: str,
                            candidates: list[Candidate],
                            dag: ExecutionDAG,
                            max_rounds: int = 3,
                            score_threshold: float = 0.5,
                            as_of: Optional[float] = None) -> LoopResult:
    """Manages the critique/judge loop with termination guarantees (ADR-005).
    
    In a real run, if candidates score poorly, we would prompt specialists
    to revise. Here we simulate the termination logic: finding the argmax,
    handling tie-breaks, and enforcing hard budgets.
    """
    round_num = 0
    best_candidate: Optional[Candidate] = None
    best_score = -math.inf

    while round_num < max_rounds:
        round_num += 1
        
        # 1. Judge evaluates
        scores: list[tuple[float, Candidate]] = []
        for c in candidates:
            score = evaluate_candidate(store, c, as_of=as_of)
            scores.append((score, c))
            
            # Record judgment in DAG
            dag.record(ExecutionNode(
                type="judge_decision",
                inputs={"candidate_text": c.text, "claim": c.claim_id},
                result={"score": score}
            ))

        # Sort by score desc, then by highest evidence (tie-break 1), then lowest risk (tie-break 2)
        scores.sort(key=lambda x: (
            x[0], 
            net_support(store, x[1].claim_id, as_of) if x[1].claim_id else 0.0,
            -x[1].risk_penalty
        ), reverse=True)

        best_score, best_candidate = scores[0]

        # 2. Check termination conditions
        if best_score >= score_threshold:
            dag.record(ExecutionNode(
                type="loop_terminate",
                inputs={"round": round_num},
                result={"status": "success", "winner": best_candidate.text}
            ))
            return LoopResult(winner=best_candidate, escalated=False, 
                              reason="Score threshold met", rounds_run=round_num, dag=dag)
        
        # 3. If below threshold, we'd normally call Critics & Specialists to revise here.
        # For the framework primitive, we just record the revision request and loop.
        dag.record(ExecutionNode(
            type="revision_request",
            inputs={"best_score": best_score, "threshold": score_threshold},
            result="Agents asked to revise"
        ))
        
        # (In a live system: candidates = specialists.revise(critiques))
    
    # 4. Max rounds exhausted -> Escalate or select best available
    if best_score > 0.0:
        dag.record(ExecutionNode(type="loop_terminate", inputs={"round": round_num}, result="max_rounds_fallback"))
        return LoopResult(winner=best_candidate, escalated=False, 
                          reason="Max rounds reached, falling back to best positive score", 
                          rounds_run=round_num, dag=dag)

    # 5. Escalate
    dag.record(ExecutionNode(type="loop_escalate", inputs={"round": round_num}, result="failed_to_find_valid_candidate"))
    return LoopResult(winner=None, escalated=True, 
                      reason="Max rounds reached, all candidates scored below 0", 
                      rounds_run=round_num, dag=dag)
