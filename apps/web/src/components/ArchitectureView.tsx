"use client";

import { useMemo, useState } from "react";
import type { ModuleGraph, VizGraph } from "@/lib/types";
import { langColor } from "@/lib/colors";
import { layeredLayout } from "@/lib/layout";
import { NodeGraph, type NGNode, type NGEdge } from "./NodeGraph";
import { GraphSearch } from "./GraphSearch";

const BOX = { w: 180, h: 64, hGap: 40, vGap: 84 };

/** A file card inside an opened module. Smaller than a module box, and deliberately so. */
const FILE = { w: 148, h: 44, gap: 18, vGap: 46 };
/** Room for the container's own title strip above the first row of files. */
const PAD = { top: 26, side: 14 };
/**
 * Which module a file belongs to.
 *
 * `buildModuleGraph` decides this server-side and its rule is conditional — a
 * top-level directory holding more than a threshold of files is split one level
 * deeper. Re-deriving that rule here would mean re-deriving the threshold against a
 * file list the client does not fully have (`VIZ_NODE_CAP` truncates it), so instead
 * the answer is looked UP: try the two-segment id, and if the server minted one,
 * that is the module. Otherwise it is the top segment.
 */
function moduleOf(fileId: string, moduleIds: ReadonlySet<string>): string {
  const segs = fileId.split("/");
  if (segs.length === 1) return "(root)";
  const twoDeep = `${segs[0]}/${segs[1]}`;
  return moduleIds.has(twoDeep) ? twoDeep : segs[0];
}

export function ArchitectureView({
  modules,
  viz,
  onSelect,
  immersive = false,
}: {
  modules: ModuleGraph;
  /** File-level graph, used to fill an opened module. Without it, modules are leaves. */
  viz?: VizGraph | null;
  onSelect?: (id: string | null) => void;
  /** Full-bleed canvas: fills parent height, floating search overlay. */
  immersive?: boolean;
}) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const moduleIds = new Set(modules.nodes.map((m) => m.id));

    /**
     * The files of the opened module, and the imports among them.
     *
     * Truncation is real: `VIZ_NODE_CAP` means the file graph can hold fewer files
     * than the module claims. The container reports what it can actually show rather
     * than the module's own count, because a box captioned "17 files" containing nine
     * of them is a lie the user has no way to detect.
     */
    const children =
      expandedId && viz
        ? viz.nodes.filter((n) => n.kind === "file" && moduleOf(n.id, moduleIds) === expandedId)
        : [];

    // The imports among the revealed files — needed before layout, because they are
    // what decides where the files go.
    const shown = new Set(children.map((f) => f.id));
    const childEdges = viz
      ? viz.edges
          .filter((e) => e.kind === "imports" && shown.has(e.source) && shown.has(e.target))
          .map((e) => ({ source: e.source, target: e.target }))
      : [];

    /**
     * Depth by longest dependency chain, so the inside of a module is drawn with the
     * same grammar as the outside of the repository: importers above what they import.
     *
     * A grid was the first attempt and it hid the answer. Packed four to a row, the
     * files sat close enough that every edge between them ran underneath a card —
     * 94 real import relationships rendered and none of them visible. Tiers separate
     * the rows that edges have to cross, which is what makes them legible.
     *
     * Iterated to a fixed point rather than by recursion: an import cycle would send
     * a depth-first walk round forever, and cycles between files in one module are
     * common enough that the layout cannot assume their absence. The pass count is
     * bounded by the node count, so a cycle just stops improving.
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
    const containerSize = inner
      ? { w: inner.width + PAD.side * 2, h: inner.height + PAD.top }
      : undefined;

    const ids = modules.nodes.map((m) => m.id);
    const tierOf = new Map(modules.nodes.map((m) => [m.id, m.tier]));
    const { pos } = layeredLayout(ids, modules.edges, tierOf, BOX, (id) =>
      id === expandedId ? containerSize : undefined
    );

    const nodes: NGNode[] = modules.nodes.map((m) => {
      const p = pos.get(m.id)!;
      const open = m.id === expandedId && children.length > 0;
      return {
        id: m.id,
        x: p.x,
        y: p.y,
        w: open ? containerSize!.w : BOX.w,
        h: open ? containerSize!.h : BOX.h,
        label: m.label,
        subtitle: `${m.language || "mixed"} · ${m.files} files`,
        meta: `${m.loc.toLocaleString()} LOC${m.issues ? ` · ${m.issues} issue(s)` : ""}`,
        color: langColor(m.language),
        issues: m.issues,
        container: open,
        // Only offer the affordance where there is genuinely an inside to show.
        expandable: !!viz && m.files > 1,
      };
    });

    const edges: NGEdge[] = modules.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
    }));

    if (inner) {
      const c = pos.get(expandedId!)!;
      // `layeredLayout` returns coordinates in its own frame; shift that frame so its
      // top-left lands just inside the container's title strip.
      const dx = c.x - containerSize!.w / 2 + PAD.side;
      const dy = c.y - containerSize!.h / 2 + PAD.top;
      for (const f of children) {
        const p = inner.pos.get(f.id)!;
        nodes.push({
          id: f.id,
          x: dx + p.x - PAD.side,
          y: dy + p.y - PAD.top,
          w: FILE.w,
          h: FILE.h,
          label: f.label,
          subtitle: `${f.loc} LOC`,
          color: langColor(f.language),
          issues: f.issues,
          parent: expandedId!,
        });
      }
      // Only edges BETWEEN the revealed files. A file's imports that leave the module
      // are already drawn, aggregated, as the module's own edges — redrawing them
      // per-file would double every cross-module relationship on screen.
      edges.push(...childEdges);
    }

    return { nodes, edges };
  }, [modules, viz, expandedId]);

  if (!nodes.length) {
    return <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-xl p-xl text-center">No module structure detected.</p>;
  }

  if (immersive) {
    return (
      <div className="relative h-full w-full">
        {/* Floating search — top-left, Apple Maps style */}
        <div className="absolute top-md left-md z-10 w-64">
          <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder="Search modules…" />
        </div>
        <NodeGraph
          nodes={nodes}
          edges={edges}
          fill
          focusId={focusId}
          onSelect={onSelect}
          onExpand={setExpandedId}
          expandedId={expandedId}
        />
      </div>
    );
  }

  return (
    <div className="space-y-sm">
      <GraphSearch nodes={nodes} onFocus={setFocusId} placeholder="Search modules…" />
      <NodeGraph
        nodes={nodes}
        edges={edges}
        height={620}
        focusId={focusId}
        onSelect={onSelect}
        onExpand={setExpandedId}
        expandedId={expandedId}
      />
      <p className="mt-sm max-w-note text-micro text-[var(--text-muted)]">
        Top-level modules layered by dependency direction (entry points on top). Arrow
        thickness/number = import count · color = dominant language · dot = issues.
        Click a module to inspect its symbols below; open one with <b>+</b> (or double-click)
        to see the files inside it and how they import each other.
      </p>
    </div>
  );
}
