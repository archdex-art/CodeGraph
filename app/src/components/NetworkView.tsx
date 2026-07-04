"use client";

import { useMemo } from "react";
import type { VizGraph } from "@/lib/types";
import { langColor } from "@/lib/colors";
import { forceLayout } from "@/lib/layout";
import { NodeGraph, type NGNode, type NGEdge } from "./NodeGraph";

const BOX_W = 156;
const BOX_H = 56;
const MAX_NODES = 120;

export function NetworkView({ graph }: { graph: VizGraph }) {
  const { nodes, edges, shown, total } = useMemo(() => {
    // Blender-style graph of the actual import network (files only, connected).
    const importEdges = graph.edges.filter((e) => e.kind === "imports");
    const degree = new Map<string, number>();
    for (const e of importEdges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    const files = graph.nodes.filter((n) => n.kind === "file");
    // Prefer connected nodes; fall back to high fan-in / issue files.
    const ranked = [...files].sort(
      (a, b) =>
        (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
        b.fanIn - a.fanIn ||
        b.loc - a.loc
    );
    const chosen = ranked.filter((n) => (degree.get(n.id) || 0) > 0).slice(0, MAX_NODES);
    // If almost nothing is connected, show the top files anyway so the view isn't empty.
    const pool = chosen.length >= 3 ? chosen : ranked.slice(0, Math.min(MAX_NODES, 40));
    const ids = new Set(pool.map((n) => n.id));

    const edgesIn: NGEdge[] = importEdges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    const pos = forceLayout(
      pool.map((n) => n.id),
      edgesIn.map((e) => ({ source: e.source, target: e.target })),
      { collideW: BOX_W, collideH: BOX_H }
    );

    const nodes: NGNode[] = pool.map((n) => {
      const p = pos.get(n.id)!;
      return {
        id: n.id,
        x: p.x,
        y: p.y,
        w: BOX_W,
        h: BOX_H,
        label: n.label,
        subtitle: n.language || "file",
        meta: `${n.loc} LOC · in ${n.fanIn}`,
        color: langColor(n.language),
        issues: n.issues,
      };
    });

    return { nodes, edges: edgesIn, shown: pool.length, total: files.length };
  }, [graph]);

  if (!nodes.length) {
    return <p className="text-sm text-gray-600 border border-dashed border-white/10 rounded-xl p-10 text-center">No import network to display.</p>;
  }

  return (
    <div>
      <NodeGraph nodes={nodes} edges={edges} height={620} />
      <p className="mt-2 text-[11px] text-gray-600">
        File-level import network. Each box is a file; arrows point from importer → imported. Hover a node to highlight its connections.
        {shown < total ? ` Showing ${shown} most-connected of ${total} files.` : ""}
      </p>
    </div>
  );
}
