"""SQL-backed bitemporal property-graph store (ADR-001).

Implements the *same* duck-typed interface as `GraphStore` (get_node, nodes,
edges, out_edges, in_edges, add_node, add_edge, supersede_node, history) so the
typed retrieval verbs in `retrieval.py` work against it unchanged — proving the
verb contract is backend-swappable.

Runs on any DB-API 2.0 connection. Tested on stdlib `sqlite3`; the SQL is kept
portable and maps to PostgreSQL 1:1:
  - TEXT json columns here  -> JSONB in Postgres
  - `?` placeholders here    -> `%s` via the `paramstyle` shim
  - everything else (bitemporal predicate, content_hash unique, indexes) is identical.

Postgres production DDL lives in 08_api_and_schema.md.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Iterable, Optional

from .envelope import Edge, Kind, Node, Provenance, live_at

_INF = 1e18  # sentinel for "valid_to IS NULL" so SQL range predicates stay simple


def _prov_to_json(p: Provenance) -> str:
    return json.dumps(p.to_dict(), sort_keys=True)


def _prov_from_json(s: str) -> Provenance:
    d = json.loads(s)
    return Provenance(source=d["source"], model=d.get("model"),
                      version=d.get("version"), commit=d.get("commit"))


class SqlGraphStore:
    def __init__(self, conn: Optional[Any] = None) -> None:
        self.conn = conn or sqlite3.connect(":memory:")
        # Portability shim: Postgres uses %s, sqlite uses ?.
        self._ph = "?" if isinstance(self.conn, sqlite3.Connection) else "%s"
        self._init_schema()

    def _q(self, sql: str) -> str:
        return sql if self._ph == "?" else sql.replace("?", "%s")

    def _init_schema(self) -> None:
        cur = self.conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL,
                props TEXT NOT NULL, confidence REAL NOT NULL, provenance TEXT NOT NULL,
                valid_from REAL NOT NULL, valid_to REAL, commit_sha TEXT,
                content_hash TEXT PRIMARY KEY)""")  # id=logical (chains); content_hash=physical
        cur.execute("CREATE INDEX IF NOT EXISTS idx_nodes_id ON nodes (id)")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS edges (
                id TEXT NOT NULL, rel TEXT NOT NULL, src TEXT NOT NULL,
                dst TEXT NOT NULL, kind TEXT NOT NULL, props TEXT NOT NULL,
                confidence REAL NOT NULL, provenance TEXT NOT NULL,
                valid_from REAL NOT NULL, valid_to REAL,
                content_hash TEXT PRIMARY KEY)""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_edges_id ON edges (id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_edges_src ON edges (src, rel)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst, rel)")
        self.conn.commit()

    # --- row <-> object ---------------------------------------------------
    def _row_to_node(self, r) -> Node:
        return Node(id=r[0], kind=Kind(r[1]), type=r[2], props=json.loads(r[3]),
                    confidence=r[4], provenance=_prov_from_json(r[5]),
                    valid_from=r[6], valid_to=(None if r[7] >= _INF else r[7]),
                    commit_sha=r[8])

    def _row_to_edge(self, r) -> Edge:
        return Edge(id=r[0], rel=r[1], src=r[2], dst=r[3], kind=Kind(r[4]),
                    props=json.loads(r[5]), confidence=r[6],
                    provenance=_prov_from_json(r[7]), valid_from=r[8],
                    valid_to=(None if r[9] >= _INF else r[9]))

    # --- writes -----------------------------------------------------------
    def add_node(self, node: Node) -> str:
        cur = self.conn.cursor()
        cur.execute(self._q("SELECT id FROM nodes WHERE content_hash = ?"),
                    (node.content_hash,))
        hit = cur.fetchone()
        if hit:
            return hit[0]  # content-addressed dedupe (idempotent)
        cur.execute(self._q(
            "INSERT INTO nodes (id,kind,type,props,confidence,provenance,"
            "valid_from,valid_to,commit_sha,content_hash) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)"),
            (node.id, node.kind.value, node.type, json.dumps(node.props),
             node.confidence, _prov_to_json(node.provenance), node.valid_from,
             _INF if node.valid_to is None else node.valid_to, node.commit_sha,
             node.content_hash))
        self.conn.commit()
        return node.id

    def add_edge(self, edge: Edge) -> str:
        cur = self.conn.cursor()
        for endpoint in (edge.src, edge.dst):
            cur.execute(self._q("SELECT 1 FROM nodes WHERE id = ?"), (endpoint,))
            if cur.fetchone() is None:
                raise KeyError("edge endpoints must exist")
        cur.execute(self._q("SELECT id FROM edges WHERE content_hash = ?"),
                    (edge.content_hash,))
        hit = cur.fetchone()
        if hit:
            return hit[0]
        cur.execute(self._q(
            "INSERT INTO edges (id,rel,src,dst,kind,props,confidence,provenance,"
            "valid_from,valid_to,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
            (edge.id, edge.rel, edge.src, edge.dst, edge.kind.value,
             json.dumps(edge.props), edge.confidence,
             _prov_to_json(edge.provenance), edge.valid_from,
             _INF if edge.valid_to is None else edge.valid_to, edge.content_hash))
        self.conn.commit()
        return edge.id

    def supersede_node(self, node_id: str, replacement: Optional[Node] = None,
                       at: Optional[float] = None) -> Optional[str]:
        at = time.time() if at is None else at
        cur = self.conn.cursor()
        cur.execute(self._q(
            "UPDATE nodes SET valid_to = ? WHERE id = ? AND valid_to >= ?"),
            (at, node_id, _INF))   # close only the currently-live version
        self.conn.commit()
        return self.add_node(replacement) if replacement is not None else None

    def supersede_edge(self, edge_id: str, at: Optional[float] = None) -> None:
        at = time.time() if at is None else at
        cur = self.conn.cursor()
        cur.execute(self._q(
            "UPDATE edges SET valid_to = ? WHERE id = ? AND valid_to >= ?"),
            (at, edge_id, _INF))
        self.conn.commit()

    # --- reads (temporal) -------------------------------------------------
    _NCOLS = ("id,kind,type,props,confidence,provenance,valid_from,valid_to,"
              "commit_sha FROM nodes")
    _ECOLS = ("id,rel,src,dst,kind,props,confidence,provenance,valid_from,"
              "valid_to FROM edges")

    def get_node(self, node_id: str, as_of: Optional[float] = None) -> Optional[Node]:
        t = time.time() if as_of is None else as_of
        cur = self.conn.cursor()
        cur.execute(self._q(
            f"SELECT {self._NCOLS} WHERE id = ? "
            "AND valid_from <= ? AND valid_to > ?"), (node_id, t, t))
        r = cur.fetchone()
        return self._row_to_node(r) if r else None

    def get_edge(self, edge_id: str, as_of: Optional[float] = None) -> Optional[Edge]:
        t = time.time() if as_of is None else as_of
        cur = self.conn.cursor()
        cur.execute(self._q(
            f"SELECT {self._ECOLS} WHERE id = ? "
            "AND valid_from <= ? AND valid_to > ?"), (edge_id, t, t))
        r = cur.fetchone()
        return self._row_to_edge(r) if r else None

    def nodes(self, as_of: Optional[float] = None) -> list[Node]:
        t = time.time() if as_of is None else as_of
        cur = self.conn.cursor()
        cur.execute(self._q(
            f"SELECT {self._NCOLS} WHERE valid_from <= ? AND valid_to > ?"), (t, t))
        return [self._row_to_node(r) for r in cur.fetchall()]

    def edges(self, as_of: Optional[float] = None) -> list[Edge]:
        t = time.time() if as_of is None else as_of
        cur = self.conn.cursor()
        cur.execute(self._q(
            f"SELECT {self._ECOLS} WHERE valid_from <= ? AND valid_to > ?"), (t, t))
        return [self._row_to_edge(r) for r in cur.fetchall()]

    def history(self, node_id: Optional[str] = None) -> list[Node]:
        cur = self.conn.cursor()
        if node_id is not None:
            cur.execute(self._q(f"SELECT {self._NCOLS} WHERE id = ?"), (node_id,))
        else:
            cur.execute(self._q(f"SELECT {self._NCOLS}"))
        return [self._row_to_node(r) for r in cur.fetchall()]

    def out_edges(self, node_id: str, rel_types: Optional[Iterable[str]] = None,
                  as_of: Optional[float] = None) -> list[Edge]:
        return self._dir_edges("src", node_id, rel_types, as_of)

    def in_edges(self, node_id: str, rel_types: Optional[Iterable[str]] = None,
                 as_of: Optional[float] = None) -> list[Edge]:
        return self._dir_edges("dst", node_id, rel_types, as_of)

    def _dir_edges(self, col: str, node_id: str,
                   rel_types: Optional[Iterable[str]], as_of: Optional[float]):
        t = time.time() if as_of is None else as_of
        cur = self.conn.cursor()
        rels = list(rel_types) if rel_types else None
        sql = (f"SELECT {self._ECOLS} WHERE {col} = ? "
               "AND valid_from <= ? AND valid_to > ?")
        params: list[Any] = [node_id, t, t]
        if rels:
            sql += " AND rel IN (" + ",".join("?" for _ in rels) + ")"
            params += rels
        cur.execute(self._q(sql), tuple(params))
        return [self._row_to_edge(r) for r in cur.fetchall()]
