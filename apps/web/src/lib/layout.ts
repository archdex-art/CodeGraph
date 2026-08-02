// Pure layout helpers (no React). Used to position node-graph rectangles.

export interface XY {
  x: number;
  y: number;
}

export interface SimEdge {
  source: string;
  target: string;
}

/**
 * Force-directed layout for the Blender-style network.
 * Runs synchronously to a settled state and returns id -> {x,y} (centered at 0,0).
 */
export function forceLayout(
  ids: string[],
  edges: SimEdge[],
  opts: { iterations?: number; collideW?: number; collideH?: number } = {}
): Map<string, XY> {
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    const r = 160 + Math.random() * 160;
    px[i] = Math.cos(a) * r + (Math.random() - 0.5) * 30;
    py[i] = Math.sin(a) * r + (Math.random() - 0.5) * 30;
  }

  const E = edges
    .map((e) => [idx.get(e.source), idx.get(e.target)] as [number | undefined, number | undefined])
    .filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);

  const K = Math.max(190, 900 / Math.sqrt(n + 1)); // ideal spacing (rects are big)
  const iters = opts.iterations ?? Math.min(900, 350 + n * 3);
  let alpha = 1;
  const MAXV = 80;

  for (let it = 0; it < iters; it++) {
    // Repulsion O(n^2).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = Math.random(); dy = Math.random(); }
        const d = Math.sqrt(d2);
        const f = ((K * K) / d) * 0.05 * alpha;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        vx[i] += fx; vy[i] += fy;
        vx[j] -= fx; vy[j] -= fy;
      }
    }
    // Attraction along edges.
    for (const [s, t] of E) {
      const dx = px[t] - px[s];
      const dy = py[t] - py[s];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = ((d - K) / d) * 0.5 * alpha;
      const fx = dx * f, fy = dy * f;
      vx[s] += fx; vy[s] += fy;
      vx[t] -= fx; vy[t] -= fy;
    }
    // Gravity + integrate.
    for (let i = 0; i < n; i++) {
      vx[i] += -px[i] * 0.0015 * alpha;
      vy[i] += -py[i] * 0.0015 * alpha;
      vx[i] *= 0.85; vy[i] *= 0.85;
      if (vx[i] > MAXV) vx[i] = MAXV; else if (vx[i] < -MAXV) vx[i] = -MAXV;
      if (vy[i] > MAXV) vy[i] = MAXV; else if (vy[i] < -MAXV) vy[i] = -MAXV;
      px[i] += vx[i]; py[i] += vy[i];
    }
    alpha = Math.max(0.02, alpha * 0.99);
  }

  // Collision relaxation: treat nodes as rectangles, push apart overlaps.
  if (opts.collideW && opts.collideH) {
    const cw = opts.collideW + 16;
    const ch = opts.collideH + 16;
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = px[j] - px[i];
          const dy = py[j] - py[i];
          const ox = cw - Math.abs(dx);
          const oy = ch - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            // Resolve along the axis of least penetration.
            if (ox < oy) {
              const s = (dx < 0 ? -1 : 1) * ox * 0.5;
              px[i] -= s; px[j] += s;
            } else {
              const s = (dy < 0 ? -1 : 1) * oy * 0.5;
              py[i] -= s; py[j] += s;
            }
          }
        }
      }
      if (!moved) break;
    }

    // Pack disconnected components into a compact grid. Force-directed layout
    // pushes unconnected islands far apart, which makes "fit to view" zoom
    // everything down to nothing. Packing keeps the whole graph tight.
    packComponents(px, py, E, n, opts.collideW + 40, opts.collideH + 40);
  }

  const out = new Map<string, XY>();
  for (let i = 0; i < n; i++) out.set(ids[i], { x: px[i], y: py[i] });
  return out;
}

/**
 * Translate each connected component (as a rigid block, preserving its internal
 * layout) into a shelf-packed grid so islands sit next to each other instead of
 * drifting apart. Mutates px/py in place and recenters on the origin.
 */
function packComponents(
  px: Float64Array,
  py: Float64Array,
  E: [number, number][],
  n: number,
  boxW: number,
  boxH: number
): void {
  if (n === 0) return;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  for (const [s, t] of E) {
    const ra = find(s), rb = find(t);
    if (ra !== rb) parent[ra] = rb;
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  if (groups.size <= 1) return;

  interface Comp { idxs: number[]; minX: number; minY: number; w: number; h: number; }
  const comps: Comp[] = [];
  for (const idxs of groups.values()) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of idxs) {
      minX = Math.min(minX, px[i] - boxW / 2); maxX = Math.max(maxX, px[i] + boxW / 2);
      minY = Math.min(minY, py[i] - boxH / 2); maxY = Math.max(maxY, py[i] + boxH / 2);
    }
    comps.push({ idxs, minX, minY, w: maxX - minX, h: maxY - minY });
  }
  comps.sort((a, b) => b.h - a.h);

  const gap = Math.max(boxW, boxH) * 0.5;
  const totalArea = comps.reduce((sum, c) => sum + (c.w + gap) * (c.h + gap), 0);
  const targetW = Math.max(comps[0].w, Math.sqrt(totalArea) * 1.5);

  let cursorX = 0, cursorY = 0, rowH = 0;
  for (const c of comps) {
    if (cursorX > 0 && cursorX + c.w > targetW) {
      cursorX = 0; cursorY += rowH + gap; rowH = 0;
    }
    const dx = cursorX - c.minX;
    const dy = cursorY - c.minY;
    for (const i of c.idxs) { px[i] += dx; py[i] += dy; }
    cursorX += c.w + gap;
    rowH = Math.max(rowH, c.h);
  }

  // Recenter the packed layout on the origin.
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += px[i]; cy += py[i]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) { px[i] -= cx; py[i] -= cy; }
}

/**
 * Layered (Sugiyama-lite) layout for the architecture flowchart.
 * tierOf maps id -> tier (0 = bottom). Returns centered positions + bounds.
 */
export function layeredLayout(
  ids: string[],
  edges: SimEdge[],
  tierOf: Map<string, number>,
  box: { w: number; h: number; hGap: number; vGap: number }
): { pos: Map<string, XY>; width: number; height: number } {
  const tiers = new Map<number, string[]>();
  for (const id of ids) {
    const t = tierOf.get(id) ?? 0;
    if (!tiers.has(t)) tiers.set(t, []);
    tiers.get(t)!.push(id);
  }
  const tierKeys = [...tiers.keys()].sort((a, b) => b - a); // high tier on top

  // Crossing reduction: order each row by barycenter of neighbors in the row above.
  const order = new Map<string, number>();
  tierKeys.forEach((t, rowIdx) => {
    const row = tiers.get(t)!;
    if (rowIdx === 0) {
      row.forEach((id, i) => order.set(id, i));
    } else {
      const prev = tierKeys[rowIdx - 1];
      const prevSet = new Set(tiers.get(prev));
      const bary = (id: string): number => {
        const neigh: number[] = [];
        for (const e of edges) {
          if (e.source === id && prevSet.has(e.target)) neigh.push(order.get(e.target) ?? 0);
          if (e.target === id && prevSet.has(e.source)) neigh.push(order.get(e.source) ?? 0);
        }
        return neigh.length ? neigh.reduce((a, b) => a + b, 0) / neigh.length : 1e9;
      };
      row.sort((a, b) => bary(a) - bary(b));
      row.forEach((id, i) => order.set(id, i));
    }
  });

  // Wrap very wide tiers into multiple sub-rows so boxes stay readable.
  const MAX_COLS = 8;
  const maxCols = Math.max(1, ...tierKeys.map((t) => Math.min(MAX_COLS, tiers.get(t)!.length)));
  const width = 60 * 2 + maxCols * box.w + (maxCols - 1) * box.hGap;

  const pos = new Map<string, XY>();
  let cursorY = 50;
  for (const t of tierKeys) {
    const row = tiers.get(t)!;
    const cols = Math.min(MAX_COLS, Math.max(1, row.length));
    const subRows = Math.ceil(row.length / cols);
    for (let sr = 0; sr < subRows; sr++) {
      const slice = row.slice(sr * cols, sr * cols + cols);
      const rowW = slice.length * box.w + (slice.length - 1) * box.hGap;
      const startX = (width - rowW) / 2;
      slice.forEach((id, i) => {
        pos.set(id, {
          x: startX + i * (box.w + box.hGap) + box.w / 2,
          y: cursorY + box.h / 2,
        });
      });
      cursorY += box.h + box.vGap;
    }
  }
  const height = cursorY - box.vGap + 50;

  return { pos, width, height };
}
