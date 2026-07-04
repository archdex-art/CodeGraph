"""Python code-structure extractor (FACT-grade) using stdlib `ast`.

Produces the doc-02 code-domain ontology deterministically:
  Nodes:  File, Function/Method, Class
  Edges:  CONTAINS (File->symbol), DEFINES (Class->Method),
          CALLS (static, intra-file resolvable), IMPORTS (File->module name)

stdlib `ast` is Python's native semantic analyzer: deterministic, zero-dep,
offline. Other languages plug in behind the same `Extractor` protocol (e.g. a
tree-sitter backend) without touching the pipeline.

Symbol identity uses `stable_id(fqn)` so re-runs dedupe and edges stay valid
across commits (entity resolution, doc 03 Stage 3 — exact-fqn tier).
"""

from __future__ import annotations

import ast

from ..envelope import Edge, Kind, Node, Provenance, stable_id
from .base import Extraction

_PROV = "python_ast"


class PythonAstExtractor:
    name = "python_ast"

    def supports(self, path: str) -> bool:
        return path.endswith(".py")

    def extract(self, repo_root: str, rel_path: str, source: str,
                valid_from: float, commit_sha: str | None) -> Extraction:
        prov = Provenance(source=_PROV, version="1", commit=commit_sha)
        out = Extraction()
        try:
            tree = ast.parse(source, filename=rel_path)
        except SyntaxError as e:
            out.errors.append(f"{rel_path}: syntax error: {e}")
            return out  # partial-correctness: skip this file, keep the rest

        file_id = stable_id(f"file:{rel_path}")
        out.nodes.append(Node(
            id=file_id, type="File", kind=Kind.FACT,
            props={"path": rel_path, "language": "python",
                   "loc": source.count("\n") + 1},
            provenance=prov, valid_from=valid_from, commit_sha=commit_sha))

        # Collect defined symbol fqns first so CALLS can resolve intra-file.
        defined: dict[str, str] = {}  # short name -> fqn

        def fqn(parts: list[str]) -> str:
            return f"{rel_path}::" + ".".join(parts)

        # First pass: declare symbols (functions, classes, methods).
        def declare(node, scope: list[str], container_id: str,
                    container_rel: str) -> None:
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    name = child.name
                    f = fqn(scope + [name])
                    sid = stable_id(f"sym:{f}")
                    is_method = bool(scope) and container_rel == "class"
                    defined[name] = f
                    out.nodes.append(Node(
                        id=sid, type=("Method" if is_method else "Function"),
                        kind=Kind.FACT,
                        props={"name": name, "fqn": f,
                               "async": isinstance(child, ast.AsyncFunctionDef),
                               "args": [a.arg for a in child.args.args],
                               "body_sig": _body_sig(child)},
                        provenance=prov, valid_from=valid_from,
                        commit_sha=commit_sha))
                    rel = "DEFINES" if container_rel == "class" else "CONTAINS"
                    out.edges.append(Edge(
                        id=stable_id(f"{rel}:{container_id}:{sid}"),
                        rel=rel, src=container_id, dst=sid, kind=Kind.FACT,
                        provenance=prov, valid_from=valid_from))
                    _calls(child, sid)
                    declare(child, scope + [name], sid, "function")
                elif isinstance(child, ast.ClassDef):
                    name = child.name
                    f = fqn(scope + [name])
                    cid = stable_id(f"sym:{f}")
                    defined[name] = f
                    out.nodes.append(Node(
                        id=cid, type="Class", kind=Kind.FACT,
                        props={"name": name, "fqn": f},
                        provenance=prov, valid_from=valid_from,
                        commit_sha=commit_sha))
                    out.edges.append(Edge(
                        id=stable_id(f"CONTAINS:{file_id}:{cid}"),
                        rel="CONTAINS", src=file_id, dst=cid, kind=Kind.FACT,
                        provenance=prov, valid_from=valid_from))
                    declare(child, scope + [name], cid, "class")

        # CALLS edges (deferred resolution against `defined`, captured per fn).
        pending_calls: list[tuple[str, str]] = []  # (caller_sid, callee_name)

        def _calls(fnnode, caller_sid: str) -> None:
            for n in ast.walk(fnnode):
                if isinstance(n, ast.Call):
                    callee = _call_name(n.func)
                    if callee:
                        pending_calls.append((caller_sid, callee))

        declare(tree, [], file_id, "file")

        # IMPORTS (File -> external module name node)
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                for alias in n.names:
                    _emit_import(out, file_id, alias.name, prov, valid_from)
            elif isinstance(n, ast.ImportFrom) and n.module:
                _emit_import(out, file_id, n.module, prov, valid_from)

        # Resolve intra-file CALLS to defined symbols (exact-name tier).
        for caller_sid, callee_name in pending_calls:
            target_fqn = defined.get(callee_name)
            if target_fqn is None:
                continue  # unresolved (stdlib/external) — skip, no false FACT
            callee_sid = stable_id(f"sym:{target_fqn}")
            out.edges.append(Edge(
                id=stable_id(f"CALLS:{caller_sid}:{callee_sid}"),
                rel="CALLS", src=caller_sid, dst=callee_sid, kind=Kind.FACT,
                provenance=prov, valid_from=valid_from))
        return out


def _call_name(func) -> str | None:
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _body_sig(fnnode) -> str:
    """Stable hash of a function's body — detects body-only changes that leave
    name/args identical (e.g. `return 2` -> `return 99`). Uses ast.unparse so
    formatting/whitespace doesn't churn the signature."""
    import hashlib
    try:
        src = "\n".join(ast.unparse(s) for s in fnnode.body)
    except Exception:
        src = repr([type(s).__name__ for s in fnnode.body])
    return hashlib.sha256(src.encode()).hexdigest()[:16]


def _emit_import(out: Extraction, file_id: str, module: str,
                 prov: Provenance, valid_from: float) -> None:
    mid = stable_id(f"dep:{module}")
    out.nodes.append(Node(
        id=mid, type="Dependency", kind=Kind.FACT,
        props={"name": module, "ecosystem": "pypi"},
        provenance=prov, valid_from=valid_from))
    out.edges.append(Edge(
        id=stable_id(f"IMPORTS:{file_id}:{mid}"),
        rel="IMPORTS", src=file_id, dst=mid, kind=Kind.FACT,
        provenance=prov, valid_from=valid_from))
