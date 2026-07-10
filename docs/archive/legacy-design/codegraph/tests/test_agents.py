"""Tests for the Agent Loop and Execution DAG (docs 04, 05, ADR-005)."""

import pytest

from codegraph import (
    Candidate, ExecutionDAG, ExecutionNode, GraphStore, Kind, Node,
    Provenance, critique_and_judge_loop, evaluate_candidate, stable_id, Edge
)


def test_execution_dag_content_addressing():
    dag = ExecutionDAG()
    n1 = ExecutionNode(type="model_call", inputs={"prompt": "hi"}, result="hello", model="gpt")
    id1 = dag.record(n1)
    
    # Identical inputs yield identical ID
    n2 = ExecutionNode(type="model_call", inputs={"prompt": "hi"}, result="hello", model="gpt")
    assert n2.id == id1
    
    # Different result yields different ID
    n3 = ExecutionNode(type="model_call", inputs={"prompt": "hi"}, result="bye", model="gpt")
    id3 = dag.record(n3)
    assert id3 != id1

    # Serialization round-trips
    d = dag.to_dict()
    dag2 = ExecutionDAG.from_dict(d)
    assert dag2.root_id == id1
    assert id1 in dag2.nodes
    assert id3 in dag2.nodes


def test_judge_evaluate_candidate():
    store = GraphStore()
    
    claim = Node(id=stable_id("claim:1"), type="Claim", kind=Kind.BELIEF,
                 props={"text": "Tests pass"}, provenance=Provenance("agent"))
    store.add_node(claim)

    # 1. Hard check fails -> -inf
    c1 = Candidate(text="bad", hard_check_failed=True)
    assert evaluate_candidate(store, c1) == float("-inf")
    
    # 2. Support minus risk
    # evidence(c) = 0, verification = 1.0, risk = 0
    c2 = Candidate(text="ok", verification_passed=1.0, risk_penalty=0.0)
    assert evaluate_candidate(store, c2, w_v=0.5) == 0.5
    
    # Add support to the claim
    e1 = Edge(rel="SUPPORTED_BY", src=claim.id, dst=stable_id("fact:1"),
              kind=Kind.BELIEF, confidence=0.8, provenance=Provenance("critic1"))
    store.add_node(Node(id=stable_id("fact:1"), type="Function"))
    store.add_edge(e1)
    
    c3 = Candidate(text="better", claim_id=claim.id, verification_passed=1.0, risk_penalty=1.0)
    # score = 0.4*0.8(evidence) + 0.4*1.0(verify) - 0.2*1.0(risk) = 0.32 + 0.4 - 0.2 = 0.52
    assert evaluate_candidate(store, c3, w_e=0.4, w_v=0.4, w_r=0.2) == pytest.approx(0.52)


def test_loop_termination_success():
    store = GraphStore()
    dag = ExecutionDAG()
    
    c = Candidate(text="perfect", verification_passed=1.0) # score = 0.4
    
    res = critique_and_judge_loop(store, "fix bug", [c], dag, score_threshold=0.3)
    assert not res.escalated
    assert res.winner.text == "perfect"
    assert res.rounds_run == 1
    
    # DAG recorded the judgment and termination
    types = [n.type for n in dag.nodes.values()]
    assert "judge_decision" in types
    assert "loop_terminate" in types


def test_loop_escalation_max_rounds():
    store = GraphStore()
    dag = ExecutionDAG()
    
    # Fails hard checks, score = -inf
    c = Candidate(text="bad", hard_check_failed=True)
    
    res = critique_and_judge_loop(store, "fix bug", [c], dag, max_rounds=2, score_threshold=0.5)
    
    assert res.escalated
    assert res.winner is None
    assert res.rounds_run == 2
    
    types = [n.type for n in dag.nodes.values()]
    assert "loop_escalate" in types
    assert "revision_request" in types
