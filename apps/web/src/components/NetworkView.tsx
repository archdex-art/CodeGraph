"use client";

import { useMemo, useState } from "react";
import type { VizGraph } from "@/lib/types";
import { langColor } from "@/lib/colors";
import { forceLayout, layeredLayout } from "@/lib/layout";
import { NodeGraph, type NGNode, type NGEdge } from "./NodeGraph";
import { GraphSearch } from "./GraphSearch";

const BOX_W = 156;
const BOX_H = 56;
/** Node budget for one drawing, whether it holds one module's files or every module's. */
const MAX_NODES = 120;
/** Below this a module's slice of the budget is not worth opening at all. */
const MIN_SLICE = 8;

/** A revealed file card — smaller than a module box, the same size the architecture view uses. */
const FILE = { w: 148, h: 44, gap: 18, vGap: 46 };
/** Space between an opened module's box and the first row of the files it reveals. */
const OPEN_GAP = 40;

/** Top-level directory a file belongs to — the unit a module box represents. */
function moduleOf(fileId: string): string {
  return fileId.split("/")[0] || "(root)";
}

interface Opened {
  /** Files drawn for this module, already capped. */
  children: VizGraph["nodes"];
  /** How many files the module actually has, so the caption can admit the truncation. */
  total: number;
  childEdges: NGEdge[];
  inner: ReturnType<typeof layeredLayout>;
  /** Room the module claims among its siblings: its own box, then the block of files. */
  region: { w: number; h: number };
}

export function NetworkView({ graph, onSelect, immersive = false }: { graph: VizGraph; onSelect?: (id: string | null) => void; immersive?: boolean }) {
  const [focusId, setFocusId] = useState<string | null>(null);
  /**
   * Which modules are open — none, one, or all of them.
   *
   * While anything is open the CLOSED modules are not drawn at all. Dimming them was
   * the first attempt and it kept the clutter: eleven faded boxes still occupy the
   * frame, still take layout space, and still push the files you asked to see into a
   * corner. Hiding them gives the opened module the whole canvas and makes the reveal
   * read as a step into it rather than as a busier version of the same picture.
   */
  const [openIds, setOpenIds] = useState<readonly string[]>([]);

  const { nodes, edges, moduleIdSet, expandableIds, moduleCount, filesShown, filesTotal } = useMemo(() => {
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

    const all = Array.from(groups.values()).sort((a, b) => b.files - a.files).slice(0, MAX_NODES);
    const moduleIdSet = new Set(all.map((g) => g.id));
    const expandableIds = all.filter((g) => g.files > 1).map((g) => g.id);

    const openSet = new Set(openIds.filter((id) => moduleIdSet.has(id)));
    // Opening ONE module hides the others — that is the step-into. Opening every module
    // is the opposite request, so the single-file ones (which have nothing to open) stay
    // on screen rather than vanishing for lacking an inside.
    const pool = openSet.size > 1 || !openSet.size ? all : all.filter((g) => openSet.has(g.id));
    const drawnIds = new Set(pool.map((g) => g.id));

    const moduleEdges: NGEdge[] = Array.from(groupEdges.entries())
      .map(([k, weight]) => {
        const [source, target] = k.split("::");
        return { source: source!, target: target!, weight };
      })
      .filter((e) => drawnIds.has(e.source) && drawnIds.has(e.target));

    /**
     * The budget is shared. Opening every module at once and giving each of them the
     * whole cap would draw more than a thousand cards, which is the clutter this view
     * exists to avoid; each open module gets an equal slice instead, spent on the files
     * with the most imports INSIDE that module.
     */
    const slice = openSet.size ? Math.max(MIN_SLICE, Math.floor(MAX_NODES / openSet.size)) : 0;
    const opened = new Map<string, Opened>();
    for (const id of openSet) {
      const inModule = files.filter((f) => moduleOf(f.id) === id);
      const memberIds = new Set(inModule.map((f) => f.id));
      const internal = importEdges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target));
      const degree = new Map<string, number>();
      for (const e of internal) {
        degree.set(e.source, (degree.get(e.source) || 0) + 1);
        degree.set(e.target, (degree.get(e.target) || 0) + 1);
      }
      const children = [...inModule]
        .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || b.fanIn - a.fanIn || b.loc - a.loc)
        .slice(0, slice);
      if (!children.length) continue;
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

      const inner = layeredLayout(
        children.map((f) => f.id),
        childEdges,
        depth,
        { w: FILE.w, h: FILE.h, hGap: FILE.gap, vGap: FILE.vGap }
      );
      opened.set(id, {
        children,
        total: inModule.length,
        childEdges,
        inner,
        region: { w: Math.max(BOX_W, inner.width), h: BOX_H + OPEN_GAP + inner.height },
      });
    }

    const pos = forceLayout(pool.map((g) => g.id), moduleEdges, {
      collideW: BOX_W,
      collideH: BOX_H,
      // Without this an opened module is separated from its neighbours by a COLLAPSED
      // box's width and the files it reveals land on top of them.
      sizeOf: (id) => opened.get(id)?.region,
    });

    const nodes: NGNode[] = pool.map((g) => {
      const p = pos.get(g.id)!;
      const domLang = Object.entries(g.langs).sort((a, b) => b[1] - a[1])[0]?.[0];
      const region = opened.get(g.id)?.region;
      // An opened module keeps its own box size; only the space around it changes, so
      // the module list reads the same open or shut.
      return {
        id: g.id,
        x: p.x,
        y: region ? p.y - region.h / 2 + BOX_H / 2 : p.y,
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
    let filesShown = 0;
    let filesTotal = 0;

    for (const [id, o] of opened) {
      const c = pos.get(id)!;
      // `layeredLayout` positions inside its own frame, top-left at (0,0); drop that
      // frame directly beneath the module's box.
      const dx = c.x - o.inner.width / 2;
      const dy = c.y - o.region.h / 2 + BOX_H + OPEN_GAP;
      for (const f of o.children) {
        const p = o.inner.pos.get(f.id)!;
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
          parent: id,
        });
      }
      // Only edges BETWEEN the revealed files. Their imports that leave the module are
      // already drawn, aggregated, as the module's own edges.
      edges.push(...o.childEdges);
      filesShown += o.children.length;
      filesTotal += o.total;
    }

    return { nodes, edges, moduleIdSet, expandableIds, moduleCount: all.length, filesShown, filesTotal };
  }, [graph, openIds]);

  if (!nodes.length) {
    return <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-xl p-xl text-center">No import network to display.</p>;
  }

  /**
   * Clicking a module REVEALS its files and hides the other modules; clicking empty
   * canvas (`id === null`) brings them back. Emphasis is a separate thing and lives in
   * NodeGraph: hovering dims what the hovered node does not touch.
   *
   * `focusId` is CLEARED rather than pointed at the module. NodeGraph re-fits the camera
   * whenever the layout's bounds change, which frames what is now on screen; a focus
   * overrides that fit with a centre-on-one-node at a clamped zoom.
   */
  const show = (ids: readonly string[]) => {
    setOpenIds(ids);
    setFocusId(null);
  };
  const handleSelect = (id: string | null) => {
    if (id === null) {
      show([]);
      return;
    }
    if (moduleIdSet.has(id)) {
      if (!openIds.includes(id)) show([id]);
      return;
    }
    onSelect?.(id);
  };
  const allOpen = openIds.length > 1;
  const scope = openIds.length
    ? `${allOpen ? "every module" : openIds[0]} · ${filesShown === filesTotal ? filesShown : `${filesShown} of ${filesTotal}`} files`
    : `${moduleCount} modules`;

  /** Small floating control: open every module at once, or put them all away. */
  const expandAll = (
    <button
      onClick={() => show(allOpen ? [] : expandableIds)}
      className="group flex items-center gap-2xs self-start rounded-full border border-[var(--line)] bg-[var(--surface-1)]/85 px-sm py-xs text-micro text-[var(--text-secondary)] shadow-lg backdrop-blur transition-[transform,color,border-color,background-color] duration-200 ease-out hover:-translate-y-px hover:border-[var(--accent-text)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:translate-y-0"
      title={allOpen ? "Close every module" : "Open every module at once"}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 transition-transform duration-300 ease-out group-hover:scale-110" aria-hidden>
        {allOpen ? (
          <path d="M6 2.5 H3.5 V6 M10 2.5 H12.5 V6 M6 13.5 H3.5 V10 M10 13.5 H12.5 V10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : (
          <path d="M2.5 6 V2.5 H6 M13.5 6 V2.5 H10 M2.5 10 V13.5 H6 M13.5 10 V13.5 H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        )}
      </svg>
      {allOpen ? "Collapse all" : "Expand all"}
    </button>
  );

  if (immersive) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute top-md left-md z-10 flex w-64 flex-col gap-sm">
          <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={openIds.length ? "Search files…" : "Search modules…"} />
          <div className="flex items-center gap-sm">
            {expandAll}
            {openIds.length === 1 && (
              <button onClick={() => show([])} className="rounded-full border border-[var(--line)] bg-[var(--surface-1)]/85 px-sm py-xs text-micro text-[var(--text-secondary)] backdrop-blur transition-colors duration-200 hover:text-[var(--text-primary)]">
                Back
              </button>
            )}
          </div>
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
          onExpand={(id) => show(id && !openIds.includes(id) ? [id] : [])}
          expandedId={openIds.length === 1 ? openIds[0]! : null}
        />
      </div>
    );
  }

  return (
    <div className="space-y-sm">
      <div className="flex items-start justify-between gap-md">
        <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder={openIds.length ? "Search files…" : "Search modules…"} />
        <div className="flex items-center gap-sm">
          {expandAll}
          {openIds.length === 1 && (
            <button onClick={() => show([])} className="rounded-full border border-[var(--line)] bg-[var(--surface-1)]/85 px-sm py-xs text-micro text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--text-primary)] whitespace-nowrap">
              Back
            </button>
          )}
        </div>
      </div>
      <NodeGraph
        nodes={nodes}
        edges={edges}
        height={620}
        focusId={focusId}
        onSelect={handleSelect}
        onExpand={(id) => show(id && !openIds.includes(id) ? [id] : [])}
        expandedId={openIds.length === 1 ? openIds[0]! : null}
      />
      <p className="mt-sm max-w-note text-micro text-[var(--text-muted)]">
        Module-level import network. Each box is a directory — click one to reveal the files inside it
        and the imports between them, or open every module at once. Hover anything to dim what it does
        not touch. Showing {scope}.
      </p>
    </div>
  );
}
