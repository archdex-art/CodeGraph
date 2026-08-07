"use client";

import { useMemo, useState } from "react";
import type { VizGraph } from "@/lib/types";
import { langColor } from "@/lib/colors";
import { forceLayout } from "@/lib/layout";
import { NodeGraph, type NGNode, type NGEdge } from "./NodeGraph";
import { GraphSearch } from "./GraphSearch";

const BOX_W = 156;
const BOX_H = 56;
const MAX_NODES = 120;

export function NetworkView({ graph, onSelect, immersive = false }: { graph: VizGraph; onSelect?: (id: string | null) => void; immersive?: boolean }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const { nodes, edges, shown, total, isGrouped } = useMemo(() => {
    const importEdges = graph.edges.filter((e) => e.kind === "imports");
    const files = graph.nodes.filter((n) => n.kind === "file");

    if (!showAll) {
      // Pack by functionality (top-level directory)
      const groups = new Map<string, { id: string, loc: number, files: number, issues: number, langs: Record<string, number> }>();
      for (const f of files) {
        const dir = f.id.split('/')[0] || '(root)';
        if (!groups.has(dir)) groups.set(dir, { id: dir, loc: 0, files: 0, issues: 0, langs: {} });
        const g = groups.get(dir)!;
        g.loc += f.loc;
        g.files += 1;
        g.issues += f.issues || 0;
        if (f.language) g.langs[f.language] = (g.langs[f.language] || 0) + f.loc;
      }

      const groupEdges = new Map<string, number>();
      for (const e of importEdges) {
        const sDir = e.source.split('/')[0] || '(root)';
        const tDir = e.target.split('/')[0] || '(root)';
        if (sDir !== tDir) {
          const key = `${sDir}::${tDir}`;
          groupEdges.set(key, (groupEdges.get(key) || 0) + 1);
        }
      }

      const pool = Array.from(groups.values()).sort((a,b) => b.files - a.files).slice(0, MAX_NODES);
      const ids = new Set(pool.map((g) => g.id));

      const edgesIn = Array.from(groupEdges.entries())
        .map(([k, weight]) => {
          const [source, target] = k.split('::');
          return { source, target, weight };
        })
        .filter((e) => ids.has(e.source) && ids.has(e.target));

      const pos = forceLayout(
        pool.map((g) => g.id),
        edgesIn,
        { collideW: BOX_W, collideH: BOX_H }
      );

      const nodes: NGNode[] = pool.map((g) => {
        const p = pos.get(g.id)!;
        const domLang = Object.entries(g.langs).sort((a,b) => b[1] - a[1])[0]?.[0];
        return {
          id: g.id,
          x: p.x,
          y: p.y,
          w: BOX_W,
          h: BOX_H,
          label: g.id,
          subtitle: domLang || "mixed",
          meta: `${g.files} files · ${g.loc.toLocaleString()} LOC`,
          color: langColor(domLang),
          issues: g.issues,
          expandable: true,
        };
      });

      return { nodes, edges: edgesIn, shown: pool.length, total: groups.size, isGrouped: true };
    }

    // Blender-style graph of the actual import network (files only, connected).
    const degree = new Map<string, number>();
    for (const e of importEdges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
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

    return { nodes, edges: edgesIn, shown: pool.length, total: files.length, isGrouped: false };
  }, [graph, showAll]);

  if (!nodes.length) {
    return <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-xl p-xl text-center">No import network to display.</p>;
  }

  if (immersive) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute top-md left-md z-10 flex w-64 flex-col gap-sm">
          <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={isGrouped ? "Search modules…" : "Search files…"} />
          {showAll && (
            <button onClick={() => { setShowAll(false); setFocusId(null); }} className="self-end rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)]">
              Back to modules
            </button>
          )}
          {shown < total && (
            <div className="rounded bg-[var(--surface-1)]/80 px-xs py-2xs text-micro text-[var(--text-muted)] backdrop-blur">
              {isGrouped ? `Showing ${shown} of ${total} modules` : `Showing ${shown} most-connected of ${total} files`}
            </div>
          )}
        </div>
        <NodeGraph nodes={nodes} edges={edges} fill focusId={focusId} onSelect={isGrouped ? (id) => { if (id) setShowAll(true); } : onSelect} onExpand={isGrouped ? () => setShowAll(true) : undefined} />
      </div>
    );
  }

  return (
    <div className="space-y-sm">
      <div className="flex items-start justify-between gap-md">
        <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={isGrouped ? "Search modules…" : "Search files…"} />
        {showAll && (
          <button onClick={() => { setShowAll(false); setFocusId(null); }} className="rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)] whitespace-nowrap">
            Back to modules
          </button>
        )}
      </div>
      <NodeGraph nodes={nodes} edges={edges} height={620} focusId={focusId} onSelect={isGrouped ? (id) => { if (id) setShowAll(true); } : onSelect} onExpand={isGrouped ? () => setShowAll(true) : undefined} />
      <p className="mt-sm max-w-note text-micro text-[var(--text-muted)]">
        {isGrouped ? "Module-level import network. Each box is a directory. Click + to expand and view the detailed file graph." : "File-level import network. Each box is a file; arrows point from importer → imported."}
        {shown < total ? (isGrouped ? ` Showing ${shown} of ${total} modules.` : ` Showing ${shown} most-connected of ${total} files.`) : ""}
      </p>
    </div>
  );
}
