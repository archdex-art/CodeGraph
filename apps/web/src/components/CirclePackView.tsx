"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, pack, type HierarchyCircularNode } from "d3-hierarchy";
import type { TreeNode } from "@/lib/types";
import { extColor } from "@/lib/colors";
import { Search, X } from "lucide-react";
import { useGraphUrl } from "@/lib/useGraphUrl";
import { plural } from "@/lib/plural";
import { GraphExport } from "./GraphExport";

import {
  createWheelZoom,
  ZOOM_BUTTON_DURATION_MS,
  ZOOM_DURATION_MS,
  ZOOM_STEP_RATIO,
} from "@/lib/zoom";

/** Deepest zoom, as a multiple of the pack's own diameter. */
const MAX_ZOOM = 60;
/** Furthest out, same units. */
const MAX_OUT = 4;
/** Focusing a circle travels further than a notch, so it is given longer. */
const FOCUS_DURATION_MS = 480;

interface PackDatum {
  name: string;
  path: string;
  ext?: string;
  loc?: number;
  issues?: number;
  children?: PackDatum[];
}

type View = [number, number, number]; // [cx, cy, diameter] in pack coords

export function CirclePackView({
  tree,
  repoName = "",
  onSelect,
  deepLink = false,
}: {
  tree: TreeNode;
  /** Names the exported file. */
  repoName?: string;
  onSelect?: (id: string | null) => void;
  /**
   * Whether the zoomed circle belongs in the page's URL, and with it the Share pill.
   *
   * Off by default because of the embedded case: the timeline scrubber draws this view
   * as one snapshot among many, where the circle you zoomed is a detail of the frame
   * rather than the page's state — and a "Copy link" that hands back a URL missing the
   * thing it just promised to capture is worse than no button.
   */
  deepLink?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState({ w: 900, h: 600 });
  const [hover, setHover] = useState<{ d: HierarchyCircularNode<PackDatum>; x: number; y: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  /**
   * The viewport, the focused node and the drag flag live in a ref AND in state.
   *
   * The ref is what the wheel/drag/animation handlers read and write: they fire
   * dozens of times a second and each one needs the value the previous one just
   * wrote, which a state variable captured in a closure cannot give them.
   *
   * The state is what RENDER reads. Reading the ref during render (which this
   * component used to do, re-rendering via a `setFrame` counter) is a render-purity
   * violation: the output is not derived from props or state, so React is free to
   * reuse a previous render or tear under concurrent rendering. It also produced a
   * visible bug — `cursor: drag.current.on ? "grabbing" : "grab"` was evaluated
   * during a render that the mousedown never scheduled, so the grabbing cursor only
   * appeared after some *other* update happened to re-render the tree.
   *
   * `applyView`/`applyFocus` keep the two in step, and are only ever called from
   * event handlers and animation frames — never during render.
   */

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
  const wheelZoom = useRef(createWheelZoom());
  const drag = useRef<{ on: boolean; lx: number; ly: number; moved: boolean }>({ on: false, lx: 0, ly: 0, moved: false });

  const [view, setView] = useState<View>([dim / 2, dim / 2, dim]);
  const [focus, setFocus] = useState<HierarchyCircularNode<PackDatum>>(root);
  const [grabbing, setGrabbing] = useState(false);

  const applyView = (next: View) => {
    viewRef.current = next;
    setView(next);
  };
  const applyFocus = (n: HierarchyCircularNode<PackDatum>) => {
    focusRef.current = n;
    setFocus(n);
  };

  const [{ open }, setUrl] = useGraphUrl(deepLink);

  /**
   * Park on the circle the URL names — on load, and again whenever the layout is
   * rebuilt (a resize re-runs `pack()`, so every coordinate the view holds is stale).
   *
   * Snapped, not eased: this fires for an arrival, not for a gesture, and animating
   * from a viewport the visitor never saw just delays the picture they asked for.
   * The identity check is what keeps a click from being re-applied — `focusNode` has
   * already moved there and started its animation by the time the param lands, while
   * a rebuilt `root` yields fresh node objects and so always re-applies.
   */
  useEffect(() => {
    const target = (open && root.descendants().find((n) => n.data.path === open)) || root;
    if (target === focusRef.current) return;
    applyView([target.x, target.y, target.r * 2]);
    applyFocus(target);
  }, [root, open]);

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

  /**
   * Ease the view to `target`, retargeting from wherever it currently is.
   *
   * Reading `viewRef.current` as the start — rather than the previous animation's
   * origin — is what lets overlapping wheel ticks compose: each new tick continues
   * from the frame on screen instead of restarting from a stale position.
   */
  function zoomTo(target: View, dur = FOCUS_DURATION_MS) {
    const from: View = [...viewRef.current];
    const t0 = performance.now();
    // Decays to rest. An in-out curve makes a single zoom notch start slowly, which
    // reads as the surface being reluctant.
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = ease(p);
      applyView([
        from[0] + (target[0] - from[0]) * e,
        from[1] + (target[1] - from[1]) * e,
        from[2] + (target[2] - from[2]) * e,
      ]);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
  }

  function focusNode(n: HierarchyCircularNode<PackDatum>) {
    applyFocus(n);
    zoomTo([n.x, n.y, n.r * 2]);
    // The whole tree is this view's default, so it is spelled as no param at all.
    setUrl({ open: n === root ? null : n.data.path, focus: null });
  }

  /**
   * Zoom toward the cursor, keeping the world point under the pointer fixed.
   *
   * Throttled and animated by the shared policy — see `lib/zoom.ts`. The previous
   * version applied a fixed 1.15x on every wheel event with no rate limit, which on
   * a trackpad (about sixty events per second) compounded past the clamp almost
   * immediately: one flick of two fingers went from the whole tree to a single file.
   *
   * Bound natively and NON-PASSIVELY below. React registers `wheel` at the root as
   * passive, so `preventDefault()` in a synthetic handler is discarded and the
   * browser scrolls — or, for a trackpad pinch, zooms the whole document — right
   * through the graph you were aiming at.
   */
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const f = wheelZoom.current(e);
    if (f === null) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [cx, cy, cd] = viewRef.current;
    const s = dim / cd;
    const wx = (sx - vp.w / 2) / s + cx;
    const wy = (sy - vp.h / 2) / s + cy;
    // The view is a DIAMETER, so it moves opposite to scale: zooming in shrinks it.
    const nd = Math.max(dim / MAX_ZOOM, Math.min(dim * MAX_OUT, cd / f));
    const ns = dim / nd;
    zoomTo([wx - (sx - vp.w / 2) / ns, wy - (sy - vp.h / 2) / ns, nd], ZOOM_DURATION_MS);
  }

  /**
   * The handler closes over `dim` and `vp`, which change with the container, so it
   * is reached through a ref: re-subscribing a native listener on every layout
   * change would drop wheel events during the swap.
   */
  const wheelRef = useRef(onWheel);
  useEffect(() => {
    wheelRef.current = onWheel;
  });
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    wrap.addEventListener("wheel", handler, { passive: false });
    return () => wrap.removeEventListener("wheel", handler);
  }, []);

  function zoomButton(factor: number) {
    const [cx, cy, cd] = viewRef.current;
    const nd = Math.max(dim / MAX_ZOOM, Math.min(dim * MAX_OUT, cd / factor));
    zoomTo([cx, cy, nd], ZOOM_BUTTON_DURATION_MS);
  }

  function onDown(e: React.MouseEvent) {
    drag.current = { on: true, lx: e.clientX, ly: e.clientY, moved: false };
    setGrabbing(true);
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
    applyView([cx - dx / s, cy - dy / s, cd]);
  }
  function onUp() {
    drag.current.on = false;
    setGrabbing(false);
  }

  const legend = useMemo(() => {
    const set = new Set<string>();
    root.each((n) => { if (!n.children && n.data.ext) set.add(n.data.ext); });
    return [...set].sort();
  }, [root]);

  const [vx, vy, vd] = view;
  const scale = dim / vd;
  const tx = (x: number) => (x - vx) * scale + vp.w / 2;
  const ty = (y: number) => (y - vy) * scale + vp.h / 2;

  const nodes = root.descendants();
  const atRoot = focus === root;

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
    <div className="space-y-sm">
      <div className="relative w-full max-w-rail">
        <div className="flex items-center gap-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-lg px-sm py-xs focus-within:border-[var(--violet-500)]/50">
          <Search className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length) pickMatch(matches[0]);
              if (e.key === "Escape") { setQuery(""); setSearchOpen(false); }
            }}
            placeholder="Search files/folders…"
            className="bg-transparent flex-1 text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none min-w-0"
          />
          {query && (
            <button onClick={() => { setQuery(""); setSearchOpen(false); }} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {searchOpen && query && (
          <div className="absolute z-20 mt-2xs w-full max-h-72 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-2)] shadow-2xl">
            {matches.length === 0 ? (
              <p className="px-sm py-sm text-meta text-[var(--text-muted)]">No matches.</p>
            ) : (
              matches.map((n) => (
                <button key={n.data.path} onClick={() => pickMatch(n)} className="block w-full text-left px-sm py-xs hover:bg-[var(--surface-active)]">
                  <div className="text-meta text-[var(--text-primary)] truncate">{n.data.name}</div>
                  <div className="text-micro text-[var(--text-muted)] truncate font-mono">{n.data.path}</div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div ref={wrapRef} className="relative w-full h-[600px] rounded-xl border border-[var(--line)] bg-[var(--surface-1)] overflow-hidden">
        <svg
          /* How `GraphExport` finds the drawing — see `NodeGraph` for why it is not
             just `querySelector("svg")`. */
          data-graph-canvas
          width={vp.w}
          height={vp.h}
          className="block select-none"
          style={{ cursor: grabbing ? "grabbing" : "grab" }}
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
                strokeWidth={isLeaf ? (n.data.issues ? 1.5 : 0) : 1}
                opacity={isLeaf ? 0.92 : 1}
                style={{
                  fill: isLeaf ? extColor(n.data.ext) : "var(--surface-hover)",
                  stroke: isLeaf ? (n.data.issues ? "var(--coral-500)" : "none") : "var(--line)",
                  cursor: "pointer",
                }}
                /* A directory click zooms — that interaction predates the inspector and
                   is the point of a circle pack. A LEAF click did nothing at all, so the
                   inspector gets it: the file you clicked becomes the scope. */
                onClick={(e) => {
                  e.stopPropagation();
                  if (drag.current.moved) return;
                  if (n.children) focusNode(n);
                  else onSelect?.(n.data.path);
                }}
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
                fontSize={10}
                style={{ fill: "var(--text-secondary)", pointerEvents: "none" }}
              >
                {n.data.name}
              </text>
            );
          })}
        </svg>

        <div className="absolute top-md left-md flex items-center gap-sm text-meta">
          <button
            onClick={() => zoomButton(ZOOM_STEP_RATIO)}
            aria-label="Zoom in"
            className="text-meta leading-none text-[var(--text-primary)] bg-[var(--surface-active)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs w-7 h-7 flex items-center justify-center"
          >
            +
          </button>
          <button
            onClick={() => zoomButton(1 / ZOOM_STEP_RATIO)}
            aria-label="Zoom out"
            className="text-meta leading-none text-[var(--text-primary)] bg-[var(--surface-active)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs w-7 h-7 flex items-center justify-center"
          >
            −
          </button>
          <button
            onClick={() => focusNode(root)}
            className="text-[var(--text-primary)] bg-[var(--surface-active)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs px-sm py-2xs h-7"
          >
            Reset
          </button>
          {deepLink && <GraphExport canvasRef={wrapRef} repoName={repoName} view="circle-pack" />}
          {!atRoot && <span className="text-[var(--text-secondary)] font-mono">{focus.data.path}</span>}
        </div>
        <div className="absolute top-md right-md text-micro text-[var(--text-muted)]">scroll = zoom · drag = pan · click a directory to focus · size = LOC · color = file type</div>

        <div className="absolute bottom-md right-md flex flex-col gap-2xs text-micro text-[var(--text-secondary)] flex-wrap max-h-[55%]">
          {legend.map((e) => (
            <span key={e} className="flex items-center gap-xs">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: extColor(e) }} />
              {e}
            </span>
          ))}
        </div>

        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-md py-sm text-meta shadow-xl"
            style={{ left: Math.min(hover.x + 12, vp.w - 220), top: hover.y + 12, maxWidth: 240 }}
          >
            <div className="font-mono text-[var(--text-primary)] break-all">{hover.d.data.path}</div>
            <div className="text-[var(--text-secondary)] mt-2xs">
              {hover.d.children ? `${hover.d.descendants().length - 1} items` : `${hover.d.data.loc || 0} LOC`}
              {hover.d.data.issues ? ` · ${plural(hover.d.data.issues, "issue")}` : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
