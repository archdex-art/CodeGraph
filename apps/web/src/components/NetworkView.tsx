"use client";

import { useMemo, useState } from "react";
import type { VizGraph } from "@/lib/types";
import { langColor } from "@/lib/colors";
import { forceLayout, layeredLayout } from "@/lib/layout";
import { NodeGraph, type NGNode, type NGEdge } from "./NodeGraph";
import { GraphSearch } from "./GraphSearch";

const BOX_W = 156;
const BOX_H = 56;
const MAX_NODES = 120;

/** A revealed file card — smaller than a module box, the same size the architecture view uses. */
const FILE = { w: 148, h: 44, gap: 18, vGap: 46 };
/** Space between an opened module's box and the first row of the files it reveals. */
const OPEN_GAP = 40;

/** Top-level directory a file belongs to — the unit a module box represents. */
function moduleOf(fileId: string): string {
  return fileId.split("/")[0] || "(root)";
}

export function NetworkView({ graph, onSelect, immersive = false }: { graph: VizGraph; onSelect?: (id: string | null) => void; immersive?: boolean }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  /**
   * Which module is open, not merely THAT one is.
   *
   * Opening used to flip a boolean and redraw the 120 most-connected files of the whole
   * repository — every module at once, which is the picture the module view exists to
   * replace, and it did not even record which box was clicked. A module now opens IN
   * PLACE: its files appear inside it, the imports between them are drawn, and the
   * module stays where it was among its siblings.
   */
  const [openId, setOpenId] = useState<string | null>(null);

  const { nodes, edges, moduleIdSet, moduleCount, childShown, childTotal } = useMemo(() => {
    const importEdges = graph.edges.filter((e) => e.kind === "imports");
    const files = graph.nodes.filter((n) => n.kind === "file");

    // Pack by functionality (top-level directory).
    const groups = new Map<string, { id: string; loc: number; files: number; issues: number; langs: Record<string, number> }>();
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

    const pool = Array.from(groups.values()).sort((a, b) => b.files - a.files).slice(0, MAX_NODES);
    const moduleIds = new Set(pool.map((g) => g.id));

    const moduleEdges: NGEdge[] = Array.from(groupEdges.entries())
      .map(([k, weight]) => {
        const [source, target] = k.split("::");
        return { source: source!, target: target!, weight };
      })
      .filter((e) => moduleIds.has(e.source) && moduleIds.has(e.target));

    /**
     * The files of the opened module, and the imports among them. Capped like the
     * module list is, keeping the module's own hubs: degree is counted INSIDE the
     * module, so the cap does not hand the slots to files that are popular elsewhere.
     */
    const inModule = openId ? files.filter((f) => moduleOf(f.id) === openId) : [];
    const memberIds = new Set(inModule.map((f) => f.id));
    const internal = importEdges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target));
    const degree = new Map<string, number>();
    for (const e of internal) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    const children = [...inModule]
      .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || b.fanIn - a.fanIn || b.loc - a.loc)
      .slice(0, MAX_NODES);
    const shownIds = new Set(children.map((f) => f.id));
    const childEdges: NGEdge[] = internal
      .filter((e) => shownIds.has(e.source) && shownIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    /**
     * Depth by longest dependency chain, so the inside of a module is drawn with the
     * same grammar as the outside: importers above what they import. Iterated to a
     * fixed point rather than by recursion — imports between files in one module form
     * cycles often enough that a depth-first walk cannot be assumed to terminate.
     */
    const depth = new Map(children.map((f) => [f.id, 0]));
    for (let pass = 0; pass < Math.min(children.length, 12); pass++) {
      let changed = false;
      for (const e of childEdges) {
        const want = (depth.get(e.target) ?? 0) + 1;
        if (want > (depth.get(e.source) ?? 0)) {
          depth.set(e.source, want);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const inner = children.length
      ? layeredLayout(
          children.map((f) => f.id),
          childEdges,
          depth,
          { w: FILE.w, h: FILE.h, hGap: FILE.gap, vGap: FILE.vGap }
        )
      : null;
    /**
     * The room the opened module needs among its siblings: its own box, then the block
     * of files under it. Reserved through `sizeOf` so the force layout pushes the other
     * modules clear of it — nothing is drawn around the files, they are ordinary nodes
     * that happen to sit below their module.
     */
    const region = inner
      ? { w: Math.max(BOX_W, inner.width), h: BOX_H + OPEN_GAP + inner.height }
      : undefined;

    const pos = forceLayout(
      pool.map((g) => g.id),
      moduleEdges,
      {
        collideW: BOX_W,
        collideH: BOX_H,
        // Without this the opened module is separated from its neighbours by a
        // COLLAPSED box's width and the files it reveals land on top of them.
        sizeOf: (id) => (id === openId ? region : undefined),
      }
    );

    const nodes: NGNode[] = pool.map((g) => {
      const p = pos.get(g.id)!;
      const domLang = Object.entries(g.langs).sort((a, b) => b[1] - a[1])[0]?.[0];
      // An opened module keeps its own box size; only the space around it changes, so
      // the module list reads the same open or shut.
      const y = g.id === openId && region ? p.y - region.h / 2 + BOX_H / 2 : p.y;
      return {
        id: g.id,
        x: p.x,
        y,
        w: BOX_W,
        h: BOX_H,
        label: g.id,
        subtitle: domLang || "mixed",
        meta: `${g.files} files · ${g.loc.toLocaleString()} LOC`,
        color: langColor(domLang),
        issues: g.issues,
        // A module of one file has nothing to open into.
        expandable: g.files > 1,
      };
    });

    const edges: NGEdge[] = [...moduleEdges];

    if (inner && region) {
      const c = pos.get(openId!)!;
      // `layeredLayout` positions inside its own frame, top-left at (0,0); drop that
      // frame directly beneath the module's box.
      const dx = c.x - inner.width / 2;
      const dy = c.y - region.h / 2 + BOX_H + OPEN_GAP;
      for (const f of children) {
        const p = inner.pos.get(f.id)!;
        nodes.push({
          id: f.id,
          x: dx + p.x,
          y: dy + p.y,
          w: FILE.w,
          h: FILE.h,
          label: f.label,
          subtitle: f.language || "file",
          meta: `${f.loc} LOC · in ${f.fanIn}`,
          color: langColor(f.language),
          issues: f.issues,
          parent: openId!,
        });
      }
      // Only edges BETWEEN the revealed files. Their imports that leave the module are
      // already drawn, aggregated, as the module's own edges.
      edges.push(...childEdges);
    }

    return { nodes, edges, moduleIdSet: moduleIds, moduleCount: pool.length, childShown: children.length, childTotal: inModule.length };
  }, [graph, openId]);

  if (!nodes.length) {
    return <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-xl p-xl text-center">No import network to display.</p>;
  }

  /**
   * Clicking a module REVEALS its files, laid out below it as ordinary nodes; clicking
   * empty canvas (`id === null`) puts them away. Emphasis is a separate thing and lives
   * in NodeGraph: hovering any of them dims what it does not touch, which is transient
   * and follows the pointer rather than sticking to whatever was last clicked.
   *
   * `focusId` is CLEARED here rather than pointed at the module. NodeGraph re-fits the
   * camera whenever the layout's bounds change, which frames the module together with
   * the files it just revealed; a focus overrides that fit with a centre-on-one-node at
   * a clamped zoom, which put 112 of the 131 nodes outside the viewport.
   */
  const open = (id: string | null) => {
    setOpenId(id);
    setFocusId(null);
  };
  const handleSelect = (id: string | null) => {
    if (id === null) {
      open(null);
      return;
    }
    if (moduleIdSet.has(id)) {
      if (id !== openId) open(id);
      return;
    }
    onSelect?.(id);
  };
  const scope = openId
    ? `${openId} · ${childShown === childTotal ? childShown : `${childShown} of ${childTotal}`} files`
    : `${moduleCount} modules`;

  if (immersive) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute top-md left-md z-10 flex w-64 flex-col gap-sm">
          <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={openId ? `Search ${openId}…` : "Search modules…"} />
          {openId && (
            <button onClick={() => open(null)} className="self-end rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)]">
              Close {openId}
            </button>
          )}
          <div className="rounded bg-[var(--surface-1)]/80 px-xs py-2xs text-micro text-[var(--text-muted)] backdrop-blur">
            Showing {scope}
          </div>
        </div>
        <NodeGraph
          nodes={nodes}
          edges={edges}
          fill
          focusId={focusId}
          onSelect={handleSelect}
          onExpand={(id) => open(id === openId ? null : id)}
          expandedId={openId}
        />
      </div>
    );
  }

  return (
    <div className="space-y-sm">
      <div className="flex items-start justify-between gap-md">
        <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={openId ? `Search ${openId}…` : "Search modules…"} />
        {openId && (
          <button onClick={() => open(null)} className="rounded bg-[var(--surface-active)] px-sm py-xs text-micro text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] border border-[var(--line)] whitespace-nowrap">
            Close {openId}
          </button>
        )}
      </div>
      <NodeGraph
        nodes={nodes}
        edges={edges}
        height={620}
        focusId={focusId}
        onSelect={handleSelect}
        onExpand={(id) => open(id === openId ? null : id)}
        expandedId={openId}
      />
      <p className="mt-sm max-w-note text-micro text-[var(--text-muted)]">
        Module-level import network. Each box is a directory — click one to reveal the files inside it
        and the imports between them; click empty space to put them away. Hover anything to dim what it
        does not touch. Showing {scope}.
      </p>
    </div>
  );
}
