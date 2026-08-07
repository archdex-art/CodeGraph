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

/** Top-level directory a file belongs to — the unit a module box represents. */
function moduleOf(fileId: string): string {
  return fileId.split("/")[0] || "(root)";
}

export function NetworkView({ graph, onSelect, immersive = false }: { graph: VizGraph; onSelect?: (id: string | null) => void; immersive?: boolean }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  /**
   * Which module is open, not merely THAT one is.
   *
   * Expanding used to flip a boolean and redraw the 120 most-connected files of the
   * whole repository — every module at once, which is the picture the module view
   * exists to replace. Clicking a box now opens that box: the files inside it and the
   * imports between them, nothing else.
   */
  const [expandedModule, setExpandedModule] = useState<string | null>(null);

  const { nodes, edges, shown, total, isGrouped } = useMemo(() => {
    const importEdges = graph.edges.filter((e) => e.kind === "imports");
    const files = graph.nodes.filter((n) => n.kind === "file");

    if (!expandedModule) {
      // Pack by functionality (top-level directory)
      const groups = new Map<string, { id: string, loc: number, files: number, issues: number, langs: Record<string, number> }>();
      for (const f of files) {
        const dir = moduleOf(f.id);
        if (!groups.has(dir)) groups.set(dir, { id: dir, loc: 0, files: 0, issues: 0, langs: {} });
        const g = groups.get(dir)!;
        g.loc += f.loc;
        g.files += 1;
        g.issues += f.issues || 0;
        if (f.language) g.langs[f.language] = (g.langs[f.language] || 0) + f.loc;
      }

      const groupEdges = new Map<string, number>();
      for (const e of importEdges) {
        const sDir = moduleOf(e.source);
        const tDir = moduleOf(e.target);
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
          // A module of one file has nothing to open into; offering `+` there promises
          // a drill-down that would redraw the same single box.
          expandable: g.files > 1,
        };
      });

      return { nodes, edges: edgesIn, shown: pool.length, total: groups.size, isGrouped: true };
    }

    // One module, opened: the files INSIDE it and the imports BETWEEN them. Ranking by
    // degree within the module (not repo-wide) is what makes the cap keep this module's
    // hubs rather than whichever files happen to be popular elsewhere.
    const inModule = files.filter((n) => moduleOf(n.id) === expandedModule);
    const memberIds = new Set(inModule.map((n) => n.id));
    const internalEdges = importEdges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target));

    const degree = new Map<string, number>();
    for (const e of internalEdges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    // Prefer connected nodes; fall back to high fan-in / issue files.
    const ranked = [...inModule].sort(
      (a, b) =>
        (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
        b.fanIn - a.fanIn ||
        b.loc - a.loc
    );
    const chosen = ranked.filter((n) => (degree.get(n.id) || 0) > 0).slice(0, MAX_NODES);
    // A module whose files barely import each other still has files worth seeing.
    const pool = chosen.length >= 3 ? chosen : ranked.slice(0, Math.min(MAX_NODES, 40));
    const ids = new Set(pool.map((n) => n.id));

    const edgesIn: NGEdge[] = internalEdges
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

    return { nodes, edges: edgesIn, shown: pool.length, total: inModule.length, isGrouped: false };
  }, [graph, expandedModule]);

  if (!nodes.length) {
    return (
      <div className="space-y-sm text-center">
        <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-xl p-xl">
          {expandedModule ? `No files to display inside ${expandedModule}.` : "No import network to display."}
        </p>
        {expandedModule && (
          <button onClick={() => { setExpandedModule(null); setFocusId(null); }} className="rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)]">
            Back to modules
          </button>
        )}
      </div>
    );
  }

  // Clicking a module HIGHLIGHTS it (NodeGraph dims everything not joined to the
  // selection); opening it is the `+` button or a double-click, and opens that module
  // alone. Those were the same gesture before, which is why one click produced the
  // whole-repository file graph.
  const openModule = (id: string | null) => {
    if (!id) return;
    setExpandedModule(id);
    setFocusId(null);
  };
  const closeModule = () => {
    setExpandedModule(null);
    setFocusId(null);
  };
  const scopeLabel = isGrouped
    ? `Showing ${shown} of ${total} modules`
    : `${expandedModule} · showing ${shown} of ${total} files inside`;

  if (immersive) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute top-md left-md z-10 flex w-64 flex-col gap-sm">
          <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={isGrouped ? "Search modules…" : `Search files in ${expandedModule}…`} />
          {!isGrouped && (
            <button onClick={closeModule} className="self-end rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)]">
              Back to modules
            </button>
          )}
          <div className="rounded bg-[var(--surface-1)]/80 px-xs py-2xs text-micro text-[var(--text-muted)] backdrop-blur">
            {scopeLabel}
          </div>
        </div>
        <NodeGraph nodes={nodes} edges={edges} fill focusId={focusId} onSelect={isGrouped ? undefined : onSelect} onExpand={isGrouped ? openModule : undefined} />
      </div>
    );
  }

  return (
    <div className="space-y-sm">
      <div className="flex items-start justify-between gap-md">
        <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={isGrouped ? "Search modules…" : `Search files in ${expandedModule}…`} />
        {!isGrouped && (
          <button onClick={closeModule} className="rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)] whitespace-nowrap">
            Back to modules
          </button>
        )}
      </div>
      <NodeGraph nodes={nodes} edges={edges} height={620} focusId={focusId} onSelect={isGrouped ? undefined : onSelect} onExpand={isGrouped ? openModule : undefined} />
      <p className="mt-sm max-w-note text-micro text-[var(--text-muted)]">
        {isGrouped
          ? "Module-level import network. Each box is a directory — click one to highlight what it connects to, or press + to open it."
          : `Files inside ${expandedModule}, and the imports between them. Arrows point from importer → imported.`}
        {` ${scopeLabel}.`}
      </p>
    </div>
  );
}
