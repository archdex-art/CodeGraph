"use client";

import { useMemo, useState } from "react";
import type { ModuleGraph } from "@/lib/types";
import { langColor } from "@/lib/colors";
import { layeredLayout } from "@/lib/layout";
import { NodeGraph, type NGNode, type NGEdge } from "./NodeGraph";
import { GraphSearch } from "./GraphSearch";

const BOX = { w: 180, h: 64, hGap: 40, vGap: 84 };

export function ArchitectureView({ modules }: { modules: ModuleGraph }) {
  const [focusId, setFocusId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const ids = modules.nodes.map((m) => m.id);
    const tierOf = new Map(modules.nodes.map((m) => [m.id, m.tier]));
    const { pos } = layeredLayout(ids, modules.edges, tierOf, BOX);

    const nodes: NGNode[] = modules.nodes.map((m) => {
      const p = pos.get(m.id)!;
      return {
        id: m.id,
        x: p.x,
        y: p.y,
        w: BOX.w,
        h: BOX.h,
        label: m.label,
        subtitle: `${m.language || "mixed"} · ${m.files} files`,
        meta: `${m.loc.toLocaleString()} LOC${m.issues ? ` · ${m.issues} issue(s)` : ""}`,
        color: langColor(m.language),
        issues: m.issues,
      };
    });
    const edges: NGEdge[] = modules.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight }));
    return { nodes, edges };
  }, [modules]);

  if (!nodes.length) {
    return <p className="text-sm text-gray-600 border border-dashed border-white/10 rounded-xl p-10 text-center">No module structure detected.</p>;
  }

  return (
    <div className="space-y-2">
      <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder="Search modules…" />
      <NodeGraph nodes={nodes} edges={edges} height={620} focusId={focusId} />
      <p className="mt-2 text-[11px] text-gray-600">
        Top-level modules layered by dependency direction (entry points on top). Arrow thickness/number = import count · color = dominant language · dot = issues.
      </p>
    </div>
  );
}
