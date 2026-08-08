"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import type { XY } from "@/lib/layout";
import {
  createWheelZoom,
  ZOOM_BUTTON_DURATION_MS,
  ZOOM_DURATION_MS,
  ZOOM_STEP_RATIO,
} from "@/lib/zoom";

/** How far in and out the diagram may be driven, in device pixels per world unit. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
/** A fit crosses the whole diagram, so it is paced with the node easing, not a zoom tick. */
const FIT_DURATION_MS = 450;

export interface NGNode {
  id: string;
  x: number; // center
  y: number;
  w: number;
  h: number;
  label: string;
  subtitle?: string;
  meta?: string;
  color: string;
  issues?: number;
  /** Drawn as a region holding other nodes rather than as a card. */
  container?: boolean;
  /** Offers the drill-down affordance. */
  expandable?: boolean;
  /** Id of the container this node is drawn inside. */
  parent?: string;
}

export interface NGEdge {
  source: string;
  target: string;
  weight?: number;
}

interface View {
  scale: number;
  ox: number;
  oy: number;
}

function borderPoint(n: NGNode, towardX: number, towardY: number) {
  const dx = towardX - n.x;
  const dy = towardY - n.y;
  const adx = Math.abs(dx) || 1e-6;
  const ady = Math.abs(dy) || 1e-6;
  const t = Math.min((n.w / 2) / adx, (n.h / 2) / ady);
  return { x: n.x + dx * t, y: n.y + dy * t };
}

function edgePath(s: NGNode, t: NGNode) {
  const start = borderPoint(s, t.x, t.y);
  const end = borderPoint(t, s.x, s.y);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let c1x, c1y, c2x, c2y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    c1x = start.x; c1y = start.y + dy * 0.5;
    c2x = end.x; c2y = end.y - dy * 0.5;
  } else {
    c1x = start.x + dx * 0.5; c1y = start.y;
    c2x = end.x - dx * 0.5; c2y = end.y;
  }
  return { d: `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`, end };
}

export interface NGBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The transform that fits `bounds` inside `vp`. Pure — exported for tests. */
export function fitView(bounds: NGBounds, vp: { w: number; h: number }): View {
  const pad = 40;
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.max(0.15, Math.min(2.2, Math.min((vp.w - pad * 2) / spanX, (vp.h - pad * 2) / spanY)));
  return {
    scale,
    ox: vp.w / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    oy: vp.h / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
  };
}

/** The transform that centres `n` without zooming further than [0.8, 2]. Pure. */
export function centreView(n: { x: number; y: number }, v: View, vp: { w: number; h: number }): View {
  const scale = Math.max(0.8, Math.min(2, v.scale || 1));
  return { scale, ox: vp.w / 2 - n.x * scale, oy: vp.h / 2 - n.y * scale };
}

/**
 * Fraction of the remaining distance RETAINED per 60fps frame. 0.78 settles a
 * module-sized expansion in roughly 450ms — long enough to read as one box opening,
 * short enough that a second click never queues behind the first. Frame-rate
 * independence comes from raising it to `dt/16.67`, so a 120Hz display eases over
 * the same wall-clock time.
 *
 * Exponential rather than a spring: springs overshoot, and overshoot on a diagram
 * whose boxes nearly touch reads as a collision rather than as bounce.
 */
const EASE_RETENTION = 0.78;

/**
 * Longest frame the easing will honour. The click that starts an expansion also
 * runs a layout pass, so the first frame after it can be 60ms+ — and charging the
 * full elapsed time against a 60fps curve spent 40% of the travel in one jump,
 * which is the lurch the easing exists to remove. Two frames' worth is the cap:
 * a real hitch slows the animation slightly rather than teleporting through it.
 */
const MAX_STEP_MS = 33;

/** Below this, snap. Chasing sub-pixel deltas keeps a rAF loop alive forever. */
const SETTLE_EPSILON = 0.35;

/** The animated part of a node: where it is and how big it is. */
type Rect = { x: number; y: number; w: number; h: number };

/** Stable empty map: a fresh one per render would restart the memo every frame. */
const NO_RECTS: Map<string, Rect> = new Map();

/**
 * The geometry the frame draws, eased toward the geometry the layout asked for.
 *
 * SIZE is interpolated alongside position because opening a module changes it from
 * a 180px card into a container several hundred pixels wide. Animating only the
 * centre would pop the box to full size on frame one and then slide it, which looks
 * like two unrelated events rather than one box opening.
 *
 * The whole diagram interpolates through ONE loop rather than one animation per
 * node, because an edge is drawn from two node rects: if nodes animated
 * independently — CSS transitions, or a spring per `<g>` — each path would be
 * recomputed from whatever mixture of old and new geometry React last committed,
 * and edges would visibly detach from their boxes for the length of the transition.
 * Reading every rect from one frame-synchronised map is what keeps them welded.
 */
function useAnimatedRects(nodes: NGNode[], animate: boolean): Map<string, Rect> {
  // A FRESH map per frame, never a mutated one. The rendered node list is memoised
  // on this value, and an in-place mutation keeps the same identity — so the memo
  // never invalidated, `drawn` stayed stale, and the eased coordinates were computed
  // every frame and shown on none of them. The animation existed and was invisible.
  // The eased map is STATE, because render reads it. `working` is the loop's own
  // memory of the last frame and is touched only from inside the loop — never during
  // render, which is the rule the earlier version broke.
  const [rects, setRects] = useState<Map<string, Rect>>(NO_RECTS);
  const working = useRef(new Map<string, Rect>());
  const raf = useRef<number | undefined>(undefined);
  const last = useRef(0);

  /**
   * Targets are derived in render; the eased map is touched ONLY inside the loop.
   *
   * Seeding newcomers here used to write to the ref during render, which React
   * forbids for good reason — under concurrent rendering a discarded render would
   * still have mutated it. No seeding is needed anyway: a node absent from the eased
   * map falls back to its own target in `drawn`, so a file revealed by an expansion
   * simply appears at its final place inside the container that is growing around it,
   * which is the origin the animation wanted for it in the first place. Departed
   * nodes need no cleanup either, because each frame builds a fresh map from
   * `targets` and never carries a key forward.
   */
  const targets = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));

  useEffect(() => {
    // Reduced motion needs no state at all: the hook returns an empty map below and
    // `drawn` falls back to each node's own target, which IS the settled layout.
    if (!animate) return;
    const step = (now: number) => {
      const dt = last.current ? Math.min(MAX_STEP_MS, now - last.current) : 16.67;
      last.current = now;
      const k = 1 - Math.pow(EASE_RETENTION, dt / 16.67);
      const next = new Map<string, Rect>();
      let moving = false;
      for (const [id, t] of targets) {
        const c = working.current.get(id) ?? t;
        const settled =
          Math.abs(t.x - c.x) < SETTLE_EPSILON &&
          Math.abs(t.y - c.y) < SETTLE_EPSILON &&
          Math.abs(t.w - c.w) < SETTLE_EPSILON &&
          Math.abs(t.h - c.h) < SETTLE_EPSILON;
        if (settled) {
          next.set(id, { ...t });
          continue;
        }
        next.set(id, {
          x: c.x + (t.x - c.x) * k,
          y: c.y + (t.y - c.y) * k,
          w: c.w + (t.w - c.w) * k,
          h: c.h + (t.h - c.h) * k,
        });
        moving = true;
      }
      working.current = next;
      setRects(next);
      raf.current = moving ? requestAnimationFrame(step) : undefined;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      last.current = 0;
    };
    // `targets` is rebuilt every render; the layout it encodes is what must retrigger
    // the loop, so the dependency is that layout's identity, not the Map's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, animate]);

  return animate ? rects : NO_RECTS;
}

export function NodeGraph({
  nodes,
  edges,
  height = 600,
  /** When true the wrapper fills its parent instead of using a fixed pixel height. */
  fill = false,
  onSelect,
  onExpand,
  expandedId,
  focusId,
}: {
  nodes: NGNode[];
  edges: NGEdge[];
  height?: number;
  fill?: boolean;
  onSelect?: (id: string | null) => void;
  /** Given for a node that can be drilled into. Absent = the node is a leaf. */
  onExpand?: (id: string | null) => void;
  expandedId?: string | null;
  /** Externally-driven "jump to this node" — e.g. from a search bar. Centers
   *  the view on the matching node and highlights it like a click/hover would. */
  focusId?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState({ w: 900, h: fill ? 800 : height });
  const [view, setView] = useState<View>({ scale: 1, ox: 0, oy: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  /**
   * The node a SEARCH just landed on, as distinct from the node you clicked.
   *
   * Both end up selected, but they need different treatment: a click happens where
   * your eye already is, whereas a search result arrives after the camera has flown
   * somewhere else entirely — so it has to announce where it landed. This drives a
   * one-shot halo, and it is cleared by the next manual interaction so the ring does
   * not linger as a second, competing "selected" marker.
   */
  const [focusPulseId, setFocusPulseId] = useState<string | null>(null);
  const drag = useRef<{ on: boolean; lx: number; ly: number; moved: boolean }>({ on: false, lx: 0, ly: 0, moved: false });
  // Mirrors `drag.current.on` for the cursor. The ref alone cannot drive it:
  // mutating a ref schedules no render, so the "grabbing" cursor only appeared
  // once some *other* update happened to re-render — i.e. after the first
  // mouse-move, never on mouse-down alone.
  const [grabbing, setGrabbing] = useState(false);

  // Anyone who asked for less motion gets the new layout immediately instead of
  // watching twenty boxes travel to it.
  const reducedMotion = useReducedMotion();
  const animated = useAnimatedRects(nodes, !reducedMotion);

  /**
   * What the frame actually draws: the node's identity and styling, its geometry
   * taken from the eased map. Every consumer below — edges, labels, hit targets —
   * reads this and only this, so nothing is ever drawn from a half-updated layout.
   */
  const drawn = useMemo(
    () => nodes.map((n) => ({ ...n, ...(animated.get(n.id) ?? n) })),
    [nodes, animated]
  );
  const nodeMap = useMemo(() => new Map(drawn.map((n) => [n.id, n])), [drawn]);

  /**
   * Adjacency for the hover highlight — edges, plus CONTAINMENT.
   *
   * Containment has to count. Hovering an opened module dims everything not joined
   * to it by an edge, and its own children are joined to it by nothing: the moment
   * you moved the pointer onto the container you just opened, the files inside it
   * faded out. A child and its container are as related as two nodes get.
   */
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of nodes) m.set(n.id, new Set());
    for (const e of edges) {
      m.get(e.source)?.add(e.target);
      m.get(e.target)?.add(e.source);
    }
    for (const n of nodes) {
      if (!n.parent) continue;
      m.get(n.id)?.add(n.parent);
      m.get(n.parent)?.add(n.id);
      // Siblings too: reading one file's neighbourhood should not grey out the
      // module it sits in.
      for (const s of nodes) if (s.parent === n.parent && s.id !== n.id) m.get(n.id)?.add(s.id);
    }
    return m;
  }, [nodes, edges]);

  const bounds = useMemo(() => {
    if (!nodes.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    return { minX, minY, maxX, maxY };
  }, [nodes]);

  /**
   * Camera moves the user did not make by hand glide; dragging does not.
   *
   * A transition on the pan/zoom group would put the viewport permanently behind
   * the pointer, so drag clears the flag before it touches the transform. Wheel
   * SETS it: a zoom tick is a discrete request, and playing it out is what turns a
   * scroll from a staircase into a ramp.
   *
   * The duration travels with the flag because the moves are not the same length —
   * a fit crosses the whole diagram, a zoom tick is one notch.
   */
  const [smoothView, setSmoothView] = useState(false);
  const [viewDurationMs, setViewDurationMs] = useState(ZOOM_DURATION_MS);
  const wheelZoom = useRef(createWheelZoom());

  const fit = useCallback(() => {
    setViewDurationMs(FIT_DURATION_MS);
    setSmoothView(true);
    setView(fitView(bounds, vp));
  }, [bounds, vp]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      // A `display:none` ancestor (e.g. an inactive-but-kept-mounted tab)
      // collapses this container to 0x0 — that's not a real resize we want
      // to lay out against, so keep the last known-good viewport instead.
      if (w === 0 && h === 0) return;
      setVp({ w: w || 900, h: h || (fill ? 800 : height) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, [height, fill]);

  // Auto-fit on layout/viewport change, and centre on an externally-selected
  // node. Both are derived during render rather than synced from an effect:
  // the effect version always committed one frame with the stale transform
  // first (on mount that is the unfitted `scale: 1, ox: 0, oy: 0`, i.e. a
  // graph drawn off-screen), then corrected it after paint.
  const [fitted, setFitted] = useState<{ bounds: NGBounds; w: number; h: number } | null>(null);
  if (!fitted || fitted.bounds !== bounds || fitted.w !== vp.w || fitted.h !== vp.h) {
    // The very first fit must be instant: easing from the unfitted origin would
    // fly the diagram in from off-screen on every mount.
    setSmoothView(fitted !== null);
    setFitted({ bounds, w: vp.w, h: vp.h });
    setView(fitView(bounds, vp));
  }

  /**
   * Focus is keyed on the TARGET nodes, not on what is currently drawn. `nodeMap` is
   * rebuilt every animation frame, so keying on it re-ran this block sixty times a
   * second during a transition and re-centred the camera on each one — the graph
   * shook for the length of every expansion.
   */
  const [focusApplied, setFocusApplied] = useState<{ id?: string | null; nodes?: NGNode[] }>({});
  if (focusApplied.id !== focusId || focusApplied.nodes !== nodes) {
    setFocusApplied({ id: focusId, nodes });
    const target = focusId ? nodes.find((n) => n.id === focusId) : undefined;
    if (target) {
      setSelId(target.id);
      setFocusPulseId(target.id);
      setSmoothView(true);
      setView((v) => centreView(target, v, vp));
    }
  }

  // Notifying the parent is a side effect, so it stays in an effect. `onSelect`
  // is read through a ref because callers pass an inline arrow: depending on it
  // directly would re-fire the notification on every render.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  useEffect(() => {
    if (focusId && nodeMap.has(focusId)) onSelectRef.current?.(focusId);
  }, [focusId, nodeMap]);

  const active = hoverId ?? selId;
  const activeNeighbors = active ? adj.get(active) : null;
  const isDim = (id: string) => active != null && id !== active && !activeNeighbors?.has(id);
  /** Joined to the active node — drawn emphasised rather than merely un-dimmed. */
  const isNeighbor = (id: string) =>
    active != null && id !== active && !!activeNeighbors?.has(id);
  /**
   * An edge is emphasised when it touches the active node — and ALSO when it runs
   * between two of its children. Selecting a module whose files have just been revealed
   * is a request to see that module's internals; the imports among those files touch the
   * module through nothing, so the strict rule dimmed every one of them to 8% and left
   * the revealed nodes floating unconnected.
   */
  const edgeActive = (e: NGEdge) => {
    if (active == null) return false;
    if (e.source === active || e.target === active) return true;
    return nodeMap.get(e.source)?.parent === active && nodeMap.get(e.target)?.parent === active;
  };

  /**
   * A wheel tick is a request to zoom, not an immediate transform.
   *
   * The throttle lives in `createWheelZoom`; what happens here is the other half:
   * the accepted tick sets a TARGET and the group's CSS transition plays it out.
   * That also solves retargeting for free — a transition restarted mid-flight
   * interpolates from the current computed transform, so a continuous scroll is a
   * continuous ramp rather than a series of restarts from stale values.
   *
   * Bound NATIVELY and non-passively in the effect below rather than through React's
   * `onWheel`. React registers `wheel` at the root as a PASSIVE listener, so
   * `preventDefault()` inside a synthetic handler is ignored — the browser logs
   * "Unable to preventDefault inside passive event listener invocation" and keeps
   * its own behaviour. The symptom was the whole page scrolling, and pinch-zooming
   * the entire document, while you were trying to zoom the graph.
   */
  const onWheel = useCallback((e: WheelEvent) => {
    // Unconditional, and before the throttle: a tick we decide to ignore is still a
    // tick that must not scroll the page out from under the pointer. `ctrlKey` is
    // how a trackpad pinch arrives, and it is what the browser would turn into a
    // full-page zoom.
    e.preventDefault();
    const f = wheelZoom.current(e);
    if (f === null) return;
    setViewDurationMs(ZOOM_DURATION_MS);
    setSmoothView(true);
    const rect = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * f));
      const wx = (mx - v.ox) / v.scale;
      const wy = (my - v.oy) / v.scale;
      return { scale, ox: mx - wx * scale, oy: my - wy * scale };
    });
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [onWheel]);
  function zoomBy(factor: number) {
    setViewDurationMs(ZOOM_BUTTON_DURATION_MS);
    setSmoothView(true);
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const wx = (cx - v.ox) / v.scale;
      const wy = (cy - v.oy) / v.scale;
      return { scale, ox: cx - wx * scale, oy: cy - wy * scale };
    });
  }
  function onDown(e: React.MouseEvent) {
    drag.current = { on: true, lx: e.clientX, ly: e.clientY, moved: false };
    setGrabbing(true);
  }
  function onMove(e: React.MouseEvent) {
    if (!drag.current.on) return;
    setSmoothView(false);
    const dx = e.clientX - drag.current.lx;
    const dy = e.clientY - drag.current.ly;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
    drag.current.lx = e.clientX;
    drag.current.ly = e.clientY;
    setView((v) => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
  }
  function onUp() {
    drag.current.on = false;
    setGrabbing(false);
  }

  const tf = `translate(${view.ox} ${view.oy}) scale(${view.scale})`;
  // `ease-out` rather than the expo curve used for layout: a zoom tick should decay
  // to rest, and expo's long flat tail reads as the zoom having stalled.
  const viewTransition =
    smoothView && !reducedMotion ? `transform ${viewDurationMs}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";

  return (
    <div
      ref={wrapRef}
      className={`relative w-full overflow-hidden ${fill ? "" : "rounded-xl border border-[var(--line)] bg-[var(--surface-1)]"}`}
      style={fill ? { height: "100%" } : { height }}
    >
      <svg
        width={vp.w}
        height={vp.h}
        className="block select-none"
        style={{ cursor: grabbing ? "grabbing" : "grab" }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        onClick={() => { if (!drag.current.moved) { setSelId(null); setFocusPulseId(null); onSelect?.(null); } }}
      >
        <defs>
          <marker id="ng-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--text-muted)" }} />
          </marker>
          <marker id="ng-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--accent-text)" }} />
          </marker>
        </defs>

        <g transform={tf} style={{ transition: viewTransition }}>
          {/* Edges */}
          {edges.map((e, i) => {
            const s = nodeMap.get(e.source);
            const t = nodeMap.get(e.target);
            if (!s || !t) return null;
            const { d } = edgePath(s, t);
            const act = edgeActive(e);
            const dim = active != null && !act;
            return (
              <path
                key={i}
                d={d}
                fill="none"
                style={{ stroke: act ? "var(--accent-text)" : "var(--text-faint)" }}
                strokeWidth={(act ? 2.2 : 1.2 + Math.min(2.5, (e.weight ?? 1) / 4)) / 1}
                markerEnd={act ? "url(#ng-arrow-active)" : "url(#ng-arrow)"}
                opacity={dim ? 0.08 : 1}
                className={act ? "ng-flow" : undefined}
              />
            );
          })}
          {/* Edge weight labels (only when relevant) */}
          {edges.map((e, i) => {
            const s = nodeMap.get(e.source);
            const t = nodeMap.get(e.target);
            if (!s || !t || !(e.weight && e.weight > 1)) return null;
            if (active != null && !edgeActive(e)) return null;
            return (
              <text key={"w" + i} x={(s.x + t.x) / 2} y={(s.y + t.y) / 2 - 3} textAnchor="middle" fontSize={10} style={{ fill: "var(--text-muted)" }}>
                {e.weight}
              </text>
            );
          })}

          {/* Nodes. Containers first so their children paint on top of them. */}
          {[...drawn]
            .sort((a, b) => Number(!!b.container) - Number(!!a.container))
            .map((n, i) => {
            const dim = isDim(n.id);
            const isActive = n.id === active;
            const neighbor = isNeighbor(n.id);
            const pulsing = n.id === focusPulseId;
            const expanded = n.id === expandedId;
            const canExpand = !!onExpand && !!n.expandable;
            /* Keyed by render index, not by node id: ids here are file paths, and a
               `url(#src/a.py)` reference is a FuncIRI the parser has no reason to
               like. The index is stable for the length of one render, which is all
               a clip reference needs to live for. */
            const clipId = `ngc-${i}`;
            /* Subtitle and meta are ONE block, centred in the space under the header
               strip — they used to be pinned independently, subtitle to a fixed y=36
               and meta to `h - 9`. That reads fine at exactly one card height and
               drifts at every other: measured 6.4px above the pair and 9.0px below on
               a 56px card, and the two lines pull 19px apart on a 64px module box
               while nearly touching on a 44px file card. Deriving both baselines from
               the box makes the rhythm identical at every size the layout produces. */
            const BODY_TOP = 22;
            const LEAD = 11;
            const CAP = 0.72;
            const showSub = !!n.subtitle && !n.container;
            const showMeta = !!n.meta && !n.container;
            const lineCount = (showSub ? 1 : 0) + (showMeta ? 1 : 0);
            const capH = 10.5 * CAP;
            const blockH = capH + Math.max(0, lineCount - 1) * LEAD;
            const firstBase = BODY_TOP + (n.h - BODY_TOP - blockH) / 2 + capH;
            const subY = firstBase;
            const metaY = showSub ? firstBase + LEAD : firstBase;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x - n.w / 2} ${n.y - n.h / 2})`}
                opacity={dim ? 0.25 : 1}
                style={{ cursor: "pointer", transition: "opacity 0.15s" }}
                onMouseEnter={() => setHoverId(n.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={(ev) => { ev.stopPropagation(); if (!drag.current.moved) { setSelId(n.id); setFocusPulseId(null); onSelect?.(n.id); } }}
                onDoubleClick={(ev) => { ev.stopPropagation(); if (canExpand) onExpand?.(expanded ? null : n.id); }}
              >
                {/* Search landing halo. Drawn OUTSIDE the card and behind it, so it
                    reads as light coming off the node rather than another border on
                    it. `pointer-events:none` because a ring that eats clicks on the
                    node it is advertising would be a cruel joke. */}
                {pulsing && (
                  <rect
                    className="ng-focus-halo"
                    x={-7}
                    y={-7}
                    width={n.w + 14}
                    height={n.h + 14}
                    rx={16}
                    fill="none"
                    stroke="var(--accent-text)"
                    strokeWidth={2}
                    pointerEvents="none"
                  />
                )}
                <rect
                  width={n.w}
                  height={n.h}
                  rx={9}
                  strokeWidth={isActive ? 2.4 : neighbor ? 1.8 : 1.4}
                  strokeDasharray={n.container ? "5 4" : undefined}
                  style={{
                    // A container is a REGION, not a card: filling it like a card would
                    // make the files inside look like they are sitting on another box.
                    fill: n.container ? "color-mix(in srgb, var(--surface-2) 55%, transparent)" : "var(--surface-2)",
                    // Three tiers, not two: the active node takes the accent outright,
                    // a neighbour keeps its own language colour but is pulled toward
                    // the accent, and everything else is untouched. Without the middle
                    // tier "connected" and "unrelated" looked identical whenever
                    // nothing was dimmed.
                    stroke: isActive
                      ? "var(--accent-text)"
                      : neighbor
                        ? `color-mix(in srgb, var(--accent-text) 55%, ${n.color})`
                        : n.color,
                    filter: isActive
                      ? "drop-shadow(0 0 10px color-mix(in srgb, var(--accent-text) 45%, transparent))"
                      : undefined,
                    transition: "stroke 0.15s, stroke-width 0.15s, filter 0.15s",
                  }}
                />
                {/* The colour fills are CLIPPED to the card, the stroked card itself is
                    not — clipping a stroke would shave it to half width along every
                    edge. Without this the header strip's square corners sat proud of
                    the card's 9px radius at the top-right, and the accent rail bulged
                    past the rounded left corners: both were painting outside the shape
                    they belong to. */}
                <clipPath id={clipId}>
                  <rect width={n.w} height={n.h} rx={9} />
                </clipPath>
                <g clipPath={`url(#${clipId})`}>
                  {!n.container && <rect width={5} height={n.h} fill={n.color} />}
                  {/* header strip colour tint */}
                  <rect
                    x={n.container ? 0 : 5}
                    width={n.w - (n.container ? 0 : 5)}
                    height={BODY_TOP}
                    fill={n.color}
                    opacity={n.container ? 0.16 : 0.1}
                  />
                </g>
                <text x={14} y={16} fontSize={13} fontWeight={600} style={{ fill: "var(--text-primary)" }}>
                  {n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label}
                </text>
                {showSub && (
                  <text x={14} y={subY} fontSize={10.5} style={{ fill: "var(--text-secondary)" }}>
                    {n.subtitle!.length > 26 ? n.subtitle!.slice(0, 25) + "…" : n.subtitle}
                  </text>
                )}
                {showMeta && (
                  <text x={14} y={metaY} fontSize={10} style={{ fill: "var(--text-muted)" }}>
                    {n.meta}
                  </text>
                )}
                {!!n.issues && !n.container && (
                  <circle cx={n.w - 12} cy={12} r={4.5} style={{ fill: n.issues > 5 ? "var(--coral-500)" : "var(--amber-400)" }} />
                )}
                {/* The drill-down affordance. A double-click alone is not discoverable,
                    so the gesture gets a visible target — and the target is what makes
                    "this box has an inside" readable before you click anything. */}
                {canExpand && (
                  <g
                    /* A container's control lives in its TITLE STRIP, not in its
                       bottom-right corner. Containers paint beneath their own
                       children so the files read as being inside them — which also
                       meant a file card sat on top of the collapse button and ate
                       the click. The strip is the one band of a container that is
                       reserved from its contents. */
                    transform={
                      n.container
                        ? `translate(${n.w - 18} 11)`
                        : `translate(${n.w - 20} ${n.h - 18})`
                    }
                    onClick={(ev) => { ev.stopPropagation(); if (!drag.current.moved) onExpand?.(expanded ? null : n.id); }}
                  >
                    <title>{expanded ? "Collapse" : "Expand to files"}</title>
                    <rect x={-7} y={-7} width={14} height={14} rx={4} style={{ fill: "var(--surface-4)", stroke: "var(--line)" }} />
                    <path
                      d={expanded ? "M-3.2 0 H3.2" : "M-3.2 0 H3.2 M0 -3.2 V3.2"}
                      strokeWidth={1.6}
                      strokeLinecap="round"
                      style={{ stroke: "var(--text-secondary)" }}
                    />
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Controls — in fill (immersive) mode, pushed to bottom-left so they
          don't overlap the floating popup on the right. */}
      <div className={`absolute flex items-center gap-xs ${fill ? "bottom-md left-md" : "top-md right-md"}`}>
        <button onClick={() => zoomBy(1 / ZOOM_STEP_RATIO)} aria-label="Zoom out" className="text-meta leading-none text-[var(--text-primary)] bg-[var(--surface-active)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs w-7 h-7 flex items-center justify-center">
          −
        </button>
        <button onClick={() => zoomBy(ZOOM_STEP_RATIO)} aria-label="Zoom in" className="text-meta leading-none text-[var(--text-primary)] bg-[var(--surface-active)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs w-7 h-7 flex items-center justify-center">
          +
        </button>
        <button onClick={fit} className="text-micro text-[var(--text-primary)] bg-[var(--surface-active)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs px-sm py-2xs h-7">
          Fit view
        </button>
      </div>
      {!fill && (
        <div className="absolute bottom-md left-md text-micro text-[var(--text-muted)]">
          scroll = zoom · drag = pan · hover a node to highlight its connections
        </div>
      )}
    </div>
  );
}
