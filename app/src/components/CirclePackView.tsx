"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, pack, type HierarchyCircularNode } from "d3-hierarchy";
import type { TreeNode } from "@/lib/types";
import { extColor } from "@/lib/colors";
import { Search, X } from "lucide-react";

interface PackDatum {
  name: string;
  path: string;
  ext?: string;
  loc?: number;
  issues?: number;
  children?: PackDatum[];
}

type View = [number, number, number]; // [cx, cy, diameter] in pack coords

export function CirclePackView({ tree }: { tree: TreeNode }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState({ w: 900, h: 600 });
  const [hover, setHover] = useState<{ d: HierarchyCircularNode<PackDatum>; x: number; y: number } | null>(null);
  const [, setFrame] = useState(0);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  // Guard against a momentarily/CSS-hidden container (e.g. a kept-mounted but
  // inactive tab, which collapses to 0x0 via display:none) so d3's pack()
  // never receives a degenerate zero size, which throws.
  const dim = Math.max(50, Math.min(vp.w, vp.h));

  const root = useMemo(() => {
    const h = hierarchy<PackDatum>(tree as PackDatum)
      .sum((d) => (d.children ? 0 : Math.max(1, d.loc || 1)))
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    return pack<PackDatum>().size([dim, dim]).padding(3)(h);
  }, [tree, dim]);

  const viewRef = useRef<View>([dim / 2, dim / 2, dim]);
  const focusRef = useRef<HierarchyCircularNode<PackDatum>>(root);
  const raf = useRef(0);
  const drag = useRef<{ on: boolean; lx: number; ly: number; moved: boolean }>({ on: false, lx: 0, ly: 0, moved: false });

  // Reset view when the layout (size/tree) changes.
  useEffect(() => {
    viewRef.current = [root.x, root.y, root.r * 2];
    focusRef.current = root;
    setFrame((f) => f + 1);
  }, [root]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      // A `display:none` ancestor (inactive-but-kept-mounted tab) collapses
      // this container to 0x0 \u2014 not a real resize to lay out against.
      if (w === 0 && h === 0) return;
      setVp({ w: w || 900, h: h || 600 });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, []);

  function zoomTo(target: View) {
    const from: View = [...viewRef.current];
    const t0 = performance.now();
    const dur = 480;
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = ease(p);
      viewRef.current = [
        from[0] + (target[0] - from[0]) * e,
        from[1] + (target[1] - from[1]) * e,
        from[2] + (target[2] - from[2]) * e,
      ];
      setFrame((f) => f + 1);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
  }

  function focusNode(n: HierarchyCircularNode<PackDatum>) {
    focusRef.current = n;
    zoomTo([n.x, n.y, n.r * 2]);
  }

  // Free zoom toward the cursor by shrinking/growing the viewed diameter while
  // keeping the world point under the pointer fixed.
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    cancelAnimationFrame(raf.current);
    const rect = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [cx, cy, cd] = viewRef.current;
    const s = dim / cd;
    const wx = (sx - vp.w / 2) / s + cx;
    const wy = (sy - vp.h / 2) / s + cy;
    const f = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    const nd = Math.max(dim / 60, Math.min(dim * 4, cd * f));
    const ns = dim / nd;
    viewRef.current = [wx - (sx - vp.w / 2) / ns, wy - (sy - vp.h / 2) / ns, nd];
    setFrame((n) => n + 1);
  }

  function zoomButton(factor: number) {
    cancelAnimationFrame(raf.current);
    const [cx, cy, cd] = viewRef.current;
    const nd = Math.max(dim / 60, Math.min(dim * 4, cd * factor));
    viewRef.current = [cx, cy, nd];
    setFrame((n) => n + 1);
  }

  function onDown(e: React.MouseEvent) {
    drag.current = { on: true, lx: e.clientX, ly: e.clientY, moved: false };
  }
  function onMove(e: React.MouseEvent) {
    if (!drag.current.on) return;
    cancelAnimationFrame(raf.current);
    const dx = e.clientX - drag.current.lx;
    const dy = e.clientY - drag.current.ly;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
    drag.current.lx = e.clientX;
    drag.current.ly = e.clientY;
    const [cx, cy, cd] = viewRef.current;
    const s = dim / cd;
    viewRef.current = [cx - dx / s, cy - dy / s, cd];
    setFrame((n) => n + 1);
  }
  function onUp() {
    drag.current.on = false;
  }

  const legend = useMemo(() => {
    const set = new Set<string>();
    root.each((n) => { if (!n.children && n.data.ext) set.add(n.data.ext); });
    return [...set].sort();
  }, [root]);

  const [vx, vy, vd] = viewRef.current;
  const scale = dim / vd;
  const tx = (x: number) => (x - vx) * scale + vp.w / 2;
  const ty = (y: number) => (y - vy) * scale + vp.h / 2;

  const nodes = root.descendants();
  const atRoot = focusRef.current === root;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter((n) => n !== root && (n.data.name.toLowerCase().includes(q) || n.data.path.toLowerCase().includes(q))).slice(0, 30);
  }, [nodes, root, query]);

  function pickMatch(n: HierarchyCircularNode<PackDatum>) {
    focusNode(n);
    setSearchOpen(false);
  }

  return (
    <div className="space-y-2">
      <div className="relative w-full max-w-xs">
        <div className="flex items-center gap-1.5 bg-[#0a0a0a] border border-white/10 rounded-lg px-3 py-1.5 focus-within:border-purple-500/50">
          <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length) pickMatch(matches[0]);
              if (e.key === "Escape") { setQuery(""); setSearchOpen(false); }
            }}
            placeholder="Search files/folders…"
            className="bg-transparent flex-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none min-w-0"
          />
          {query && (
            <button onClick={() => { setQuery(""); setSearchOpen(false); }} className="text-gray-500 hover:text-white shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {searchOpen && query && (
          <div className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-white/10 bg-[#111113] shadow-2xl">
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-600">No matches.</p>
            ) : (
              matches.map((n) => (
                <button key={n.data.path} onClick={() => pickMatch(n)} className="block w-full text-left px-3 py-1.5 hover:bg-white/10">
                  <div className="text-xs text-gray-200 truncate">{n.data.name}</div>
                  <div className="text-[10px] text-gray-600 truncate font-mono">{n.data.path}</div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div ref={wrapRef} className="relative w-full h-[600px] rounded-xl border border-white/10 bg-[#0b0b0d] overflow-hidden">
        <svg
          width={vp.w}
          height={vp.h}
          className="block select-none"
          style={{ cursor: drag.current.on ? "grabbing" : "grab" }}
          onWheel={onWheel}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onClick={() => { if (drag.current.moved) return; if (!atRoot) focusNode(focusRef.current.parent || root); }}
        >
          {nodes.map((n) => {
            const isLeaf = !n.children;
            const r = n.r * scale;
            if (r < 1) return null;
            const x = tx(n.x), y = ty(n.y);
            if (x < -r || x > vp.w + r || y < -r || y > vp.h + r) return null;
            return (
              <circle
                key={n.data.path + n.depth}
                cx={x}
                cy={y}
                r={r}
                fill={isLeaf ? extColor(n.data.ext) : "rgba(255,255,255,0.014)"}
                stroke={isLeaf ? (n.data.issues ? "#fb7185" : "none") : "rgba(255,255,255,0.12)"}
                strokeWidth={isLeaf ? (n.data.issues ? 1.5 : 0) : 1}
                opacity={isLeaf ? 0.92 : 1}
                style={{ cursor: n.children ? "pointer" : "default" }}
                onClick={(e) => { e.stopPropagation(); if (drag.current.moved) return; if (n.children) focusNode(n); }}
                onMouseEnter={() => setHover({ d: n, x, y })}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
          {/* Constant-size directory labels */}
          {nodes.map((n) => {
            if (!n.children) return null;
            const r = n.r * scale;
            if (r < 20) return null;
            const x = tx(n.x), y = ty(n.y);
            if (x < 0 || x > vp.w || y < 0 || y > vp.h) return null;
            return (
              <text
                key={"l" + n.data.path + n.depth}
                x={x}
                y={y - r + 12}
                textAnchor="middle"
                fontSize={11}
                fill="rgba(229,231,235,0.7)"
                style={{ pointerEvents: "none" }}
              >
                {n.data.name}
              </text>
            );
          })}
        </svg>

        <div className="absolute top-3 left-3 flex items-center gap-2 text-xs">
          <button
            onClick={() => zoomButton(1 / 1.3)}
            aria-label="Zoom in"
            className="text-sm leading-none text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded w-7 h-7 flex items-center justify-center"
          >
            +
          </button>
          <button
            onClick={() => zoomButton(1.3)}
            aria-label="Zoom out"
            className="text-sm leading-none text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded w-7 h-7 flex items-center justify-center"
          >
            −
          </button>
          <button
            onClick={() => focusNode(root)}
            className="text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded px-2 py-1 h-7"
          >
            Reset
          </button>
          {!atRoot && <span className="text-gray-500 font-mono">{focusRef.current.data.path}</span>}
        </div>
        <div className="absolute top-3 right-3 text-[10px] text-gray-600">scroll = zoom · drag = pan · click a directory to focus · size = LOC · color = file type</div>

        <div className="absolute bottom-3 right-3 flex flex-col gap-1 text-[10px] text-gray-400 flex-wrap max-h-[55%]">
          {legend.map((e) => (
            <span key={e} className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: extColor(e) }} />
              {e}
            </span>
          ))}
        </div>

        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-white/10 bg-[#0d0d0d] px-3 py-2 text-xs shadow-xl"
            style={{ left: Math.min(hover.x + 12, vp.w - 220), top: hover.y + 12, maxWidth: 240 }}
          >
            <div className="font-mono text-gray-200 break-all">{hover.d.data.path}</div>
            <div className="text-gray-500 mt-0.5">
              {hover.d.children ? `${hover.d.descendants().length - 1} items` : `${hover.d.data.loc || 0} LOC`}
              {hover.d.data.issues ? ` · ${hover.d.data.issues} issue(s)` : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
