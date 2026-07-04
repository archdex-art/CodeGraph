"""Ownership extractor (FACT-grade): authors from git history + CODEOWNERS.

Produces:
  Nodes:  Person (resolved by email)
  Edges:  AUTHORED (Person -> File), OWNS (Person/Team -> path glob)

Identity resolution: Person keyed by email (doc 03 Stage 3 — the alias-merge
tier would unify handles; here we use email as the canonical key).
"""

from __future__ import annotations

import subprocess
from collections import defaultdict

from ..envelope import Edge, Kind, Node, Provenance, stable_id
from .base import Extraction

_PROV = "ownership"


class OwnershipExtractor:
    name = "ownership"

    def supports(self, path: str) -> bool:  # repo-level, not per-file
        return False

    def extract_repo(self, repo_root: str, valid_from: float,
                     commit_sha: str | None) -> Extraction:
        prov = Provenance(source=_PROV, version="1", commit=commit_sha)
        out = Extraction()
        self._authors(repo_root, prov, valid_from, out)
        self._codeowners(repo_root, prov, valid_from, out)
        return out

    def _authors(self, repo_root, prov, valid_from, out: Extraction) -> None:
        try:
            raw = subprocess.run(
                ["git", "-C", repo_root, "log", "--no-merges",
                 "--pretty=format:%ae\t%an", "--name-only"],
                capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError) as e:
            out.errors.append(f"ownership: git log failed: {e}")
            return
        if raw.returncode != 0:
            out.errors.append("ownership: not a git repo or no history")
            return

        seen_people: dict[str, str] = {}     # email -> person id
        authored: set[tuple[str, str]] = set()
        cur_email = cur_name = None
        for line in raw.stdout.splitlines():
            if "\t" in line and not line.endswith(".py") and "@" in line.split("\t")[0]:
                cur_email, cur_name = line.split("\t", 1)
                if cur_email not in seen_people:
                    pid = stable_id(f"person:{cur_email}")
                    seen_people[cur_email] = pid
                    out.nodes.append(Node(
                        id=pid, type="Person", kind=Kind.FACT,
                        props={"email": cur_email, "name": cur_name},
                        provenance=prov, valid_from=valid_from))
            elif line.strip() and cur_email and line.endswith(".py"):
                authored.add((cur_email, line.strip()))

        for email, path in authored:
            pid = seen_people[email]
            fid = stable_id(f"file:{path}")
            out.edges.append(Edge(
                id=stable_id(f"AUTHORED:{pid}:{fid}"),
                rel="AUTHORED", src=pid, dst=fid, kind=Kind.FACT,
                provenance=prov, valid_from=valid_from))

    def _codeowners(self, repo_root, prov, valid_from, out: Extraction) -> None:
        import os
        for candidate in ("CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"):
            p = os.path.join(repo_root, candidate)
            if not os.path.isfile(p):
                continue
            try:
                with open(p, encoding="utf-8") as fh:
                    lines = fh.readlines()
            except OSError as e:
                out.errors.append(f"ownership: CODEOWNERS read failed: {e}")
                return
            for line in lines:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                glob, owners = parts[0], parts[1:]
                for owner in owners:
                    oid = stable_id(f"owner:{owner}")
                    out.nodes.append(Node(
                        id=oid, type="Team" if owner.endswith("/") or "/" in owner
                        else "Person", kind=Kind.FACT,
                        props={"handle": owner}, provenance=prov,
                        valid_from=valid_from))
                    gid = stable_id(f"pathglob:{glob}")
                    out.nodes.append(Node(
                        id=gid, type="PathGlob", kind=Kind.FACT,
                        props={"glob": glob}, provenance=prov,
                        valid_from=valid_from))
                    out.edges.append(Edge(
                        id=stable_id(f"OWNS:{oid}:{gid}"),
                        rel="OWNS", src=oid, dst=gid, kind=Kind.FACT,
                        provenance=prov, valid_from=valid_from))
            return  # first found wins
