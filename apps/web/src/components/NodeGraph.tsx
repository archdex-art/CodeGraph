"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

export function NodeGraph({
  nodes,
  edges,
  height = 600,
  onSelect,
  focusId,
}: {
  nodes: NGNode[];
  edges: NGEdge[];
  height?: number;
  onSelect?: (id: string | null) => void;
  /** Externally-driven "jump to this node" — e.g. from a search bar. Centers
   *  the view on the matching node and highlights it like a click/hover would. */
  focusId?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState({ w: 900, h: height });
  const [view, setView] = useState<View>({ scale: 1, ox: 0, oy: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const drag = useRef<{ on: boolean; lx: number; ly: number; moved: boolean }>({ on: false, lx: 0, ly: 0, moved: false });

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Adjacency for hover highlight.
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of nodes) m.set(n.id, new Set());
    for (const e of edges) {
      m.get(e.source)?.add(e.target);
      m.get(e.target)?.add(e.source);
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

  const fit = useMemo(
    () => () => {
      const pad = 40;
      const spanX = Math.max(1, bounds.maxX - bounds.minX);
      const spanY = Math.max(1, bounds.maxY - bounds.minY);
      const scale = Math.max(0.15, Math.min(2.2, Math.min((vp.w - pad * 2) / spanX, (vp.h - pad * 2) / spanY)));
      setView({
        scale,
        ox: vp.w / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
        oy: vp.h / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
      });
    },
    [bounds, vp]
  );

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
      setVp({ w: w || 900, h: h || height });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, vp.w, vp.h]);

  // Search-to-focus: center the view on the externally-selected node.
  useEffect(() => {
    if (!focusId) return;
    const n = nodeMap.get(focusId);
    if (!n) return;
    setSelId(focusId);
    onSelect?.(focusId);
    setView((v) => {
      const scale = Math.max(0.8, Math.min(2, v.scale || 1));
      return { scale, ox: vp.w / 2 - n.x * scale, oy: vp.h / 2 - n.y * scale };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, nodeMap]);

  const active = hoverId ?? selId;
  const activeNeighbors = active ? adj.get(active) : null;
  const isDim = (id: string) => active != null && id !== active && !activeNeighbors?.has(id);
  const edgeActive = (e: NGEdge) => active != null && (e.source === active || e.target === active);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.max(0.1, Math.min(4, v.scale * f));
      const wx = (mx - v.ox) / v.scale;
      const wy = (my - v.oy) / v.scale;
      return { scale, ox: mx - wx * scale, oy: my - wy * scale };
    });
  }
  function zoomBy(factor: number) {
    setView((v) => {
      const scale = Math.max(0.1, Math.min(4, v.scale * factor));
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const wx = (cx - v.ox) / v.scale;
      const wy = (cy - v.oy) / v.scale;
      return { scale, ox: cx - wx * scale, oy: cy - wy * scale };
    });
  }
  function onDown(e: React.MouseEvent) {
    drag.current = { on: true, lx: e.clientX, ly: e.clientY, moved: false };
  }
  function onMove(e: React.MouseEvent) {
    if (!drag.current.on) return;
    const dx = e.clientX - drag.current.lx;
    const dy = e.clientY - drag.current.ly;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
    drag.current.lx = e.clientX;
    drag.current.ly = e.clientY;
    setView((v) => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
  }
  function onUp() {
    drag.current.on = false;
  }

  const tf = `translate(${view.ox} ${view.oy}) scale(${view.scale})`;

  return (
    <div
      ref={wrapRef}
      className="relative w-full rounded-xl border border-white/10 bg-[#0a0a0c] overflow-hidden"
      style={{ height }}
    >
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
        onClick={() => { if (!drag.current.moved) { setSelId(null); onSelect?.(null); } }}
      >
        <defs>
          <marker id="ng-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="rgba(148,163,184,0.8)" />
          </marker>
          <marker id="ng-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#22d3ee" />
          </marker>
        </defs>

        <g transform={tf}>
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
                stroke={act ? "#22d3ee" : "rgba(148,163,184,0.30)"}
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
              <text key={"w" + i} x={(s.x + t.x) / 2} y={(s.y + t.y) / 2 - 3} textAnchor="middle" fontSize={10} fill="rgba(148,163,184,0.85)">
                {e.weight}
              </text>
            );
          })}

          {/* Nodes */}
          {nodes.map((n) => {
            const dim = isDim(n.id);
            const isActive = n.id === active;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x - n.w / 2} ${n.y - n.h / 2})`}
                opacity={dim ? 0.25 : 1}
                style={{ cursor: "pointer", transition: "opacity 0.15s" }}
                onMouseEnter={() => setHoverId(n.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={(ev) => { ev.stopPropagation(); if (!drag.current.moved) { setSelId(n.id); onSelect?.(n.id); } }}
              >
                <rect
                  width={n.w}
                  height={n.h}
                  rx={9}
                  fill="#15151a"
                  stroke={isActive ? "#22d3ee" : n.color}
                  strokeWidth={isActive ? 2.2 : 1.4}
                  style={{ transition: "stroke 0.15s" }}
                />
                <rect width={5} height={n.h} rx={2.5} fill={n.color} />
                {/* header strip color tint */}
                <rect x={5} width={n.w - 5} height={22} rx={0} fill={n.color} opacity={0.10} />
                <text x={14} y={16} fontSize={13} fontWeight={600} fill="#e5e7eb">
                  {n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label}
                </text>
                {n.subtitle && (
                  <text x={14} y={36} fontSize={10.5} fill="#9ca3af">
                    {n.subtitle.length > 26 ? n.subtitle.slice(0, 25) + "…" : n.subtitle}
                  </text>
                )}
                {n.meta && (
                  <text x={14} y={n.h - 9} fontSize={10} fill="#6b7280">
                    {n.meta}
                  </text>
                )}
                {!!n.issues && (
                  <circle cx={n.w - 12} cy={12} r={4.5} fill={n.issues > 5 ? "#fb7185" : "#fbbf24"} />
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Controls */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        <button onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out" className="text-sm leading-none text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded w-7 h-7 flex items-center justify-center">
          −
        </button>
        <button onClick={() => zoomBy(1.25)} aria-label="Zoom in" className="text-sm leading-none text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded w-7 h-7 flex items-center justify-center">
          +
        </button>
        <button onClick={fit} className="text-[10px] text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded px-2 py-1 h-7">
          Fit view
        </button>
      </div>
      <div className="absolute bottom-3 left-3 text-[10px] text-gray-600">
        scroll = zoom · drag = pan · hover a node to highlight its connections
      </div>
    </div>
  );
}
