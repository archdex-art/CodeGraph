"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * The hero figure: the instrument doing the thing it does.
 *
 * Not an abstract "tech" illustration — it is the actual sequence the product
 * runs. Symbols resolve, edges link, a pass sweeps the graph, one node comes
 * back hot, and a score lands. If the picture showed anything else it would be
 * decoration on a page whose argument is that the graph IS the product.
 *
 * Coordinates are hand-placed constants, never randomised. A random layout
 * renders differently on the server and the client, and React resolves that
 * disagreement by silently keeping the server's — so the "randomness" is a lie
 * that costs a hydration mismatch.
 */

type Node = {
  id: string;
  x: number;
  y: number;
  r: number;
  kind: "core" | "leaf" | "risk" | "struct";
  label?: string;
};

const NODES: Node[] = [
  { id: "core", x: 260, y: 168, r: 15, kind: "core", label: "indexer" },
  { id: "scan", x: 138, y: 96, r: 9, kind: "struct", label: "scan" },
  { id: "detect", x: 392, y: 104, r: 10.5, kind: "struct", label: "detect" },
  { id: "score", x: 424, y: 226, r: 9, kind: "struct", label: "score" },
  { id: "graph", x: 300, y: 288, r: 10, kind: "struct", label: "graph" },
  { id: "hot", x: 146, y: 244, r: 12, kind: "risk", label: "auth.ts" },
  { id: "imports", x: 76, y: 176, r: 7.5, kind: "leaf" },
  { id: "rules", x: 470, y: 158, r: 7, kind: "leaf" },
  { id: "viz", x: 214, y: 52, r: 6.5, kind: "leaf" },
  { id: "cfg", x: 356, y: 320, r: 6, kind: "leaf" },
  { id: "fsx", x: 62, y: 292, r: 5.5, kind: "leaf" },
  { id: "verify", x: 496, y: 288, r: 6.5, kind: "leaf" },
];

const EDGES: Array<[string, string, boolean]> = [
  ["core", "scan", true],
  ["core", "detect", true],
  ["core", "score", true],
  ["core", "graph", true],
  ["core", "hot", true],
  ["scan", "imports", false],
  ["scan", "viz", false],
  ["detect", "rules", false],
  ["graph", "cfg", false],
  ["hot", "fsx", false],
  ["score", "verify", false],
  ["detect", "score", false],
];

const BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n]));

const FILL: Record<Node["kind"], string> = {
  core: "var(--signal-500)",
  struct: "var(--violet-500)",
  leaf: "var(--text-faint)",
  risk: "var(--coral-500)",
};

const EASE = [0.16, 1, 0.3, 1] as const;

export function HeroGraph() {
  const reduced = useReducedMotion();
  // Drives the post-scan state (hotspot ring, verdict chip).
  const [swept, setSwept] = useState(false);
  // DERIVED, not set in an effect: reduced motion means "show me the finished
  // frame", which is a property of the render, not an event to react to. Writing
  // it back into state would be a second render that produces the same output.
  const scanned = reduced || swept;

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setSwept(true), 2600);
    return () => clearTimeout(t);
  }, [reduced]);

  const appear = (i: number) =>
    reduced
      ? { initial: false as const, animate: { opacity: 1, scale: 1 } }
      : {
          initial: { opacity: 0, scale: 0.3 },
          animate: { opacity: 1, scale: 1 },
          transition: { delay: 0.15 + i * 0.055, type: "spring" as const, stiffness: 320, damping: 18 },
        };

  return (
    <div className="relative w-full select-none" aria-hidden="true">
      <svg viewBox="0 0 560 380" className="h-auto w-full overflow-visible">
        <defs>
          <radialGradient id="hg-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--signal-500)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--signal-500)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hg-scan" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--signal-500)" stopOpacity="0" />
            <stop offset="50%" stopColor="var(--signal-500)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--signal-500)" stopOpacity="0" />
          </linearGradient>
          <filter id="hg-soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        <circle cx="260" cy="168" r="120" fill="url(#hg-halo)" className="animate-drift" />

        {/* Edges draw after the nodes they connect have landed. `pathLength`
            animates the stroke itself rather than a dash offset hack, so the
            line grows from its source instead of sliding into place. */}
        <g fill="none" strokeLinecap="round">
          {EDGES.map(([from, to, primary], i) => {
            const a = BY_ID[from];
            const b = BY_ID[to];
            return (
              <motion.line
                key={`${from}-${to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={primary ? "var(--signal-500)" : "var(--line-strong)"}
                strokeOpacity={primary ? 0.34 : 1}
                strokeWidth={primary ? 1.15 : 0.85}
                initial={reduced ? false : { pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ delay: reduced ? 0 : 0.75 + i * 0.045, duration: 0.55, ease: EASE }}
              />
            );
          })}
        </g>

        {/* The analysis pass. One sweep, then it stops — a scan line that loops
            forever says "loading", and this graph is not loading. */}
        {!reduced && (
          <motion.g
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: [-40, 400], opacity: [0, 1, 1, 0] }}
            transition={{ delay: 1.5, duration: 1.3, ease: "easeInOut", times: [0, 0.1, 0.85, 1] }}
          >
            <rect x="0" y="0" width="560" height="1.4" fill="url(#hg-scan)" />
            <rect x="0" y="1.4" width="560" height="26" fill="var(--signal-500)" opacity="0.05" />
          </motion.g>
        )}

        {NODES.map((n, i) => (
          <motion.g key={n.id} {...appear(i)} style={{ originX: `${n.x}px`, originY: `${n.y}px` }}>
            {n.kind === "core" && (
              <circle cx={n.x} cy={n.y} r={n.r + 9} fill="var(--signal-500)" opacity="0.1" filter="url(#hg-soft)" />
            )}
            <circle cx={n.x} cy={n.y} r={n.r} fill={FILL[n.kind]} opacity={n.kind === "leaf" ? 0.55 : 1} />
            {n.kind === "core" && (
              <circle cx={n.x} cy={n.y} r={n.r} fill="none" stroke="var(--ink-900)" strokeWidth="2.5" opacity="0.35" />
            )}
          </motion.g>
        ))}

        {/* The finding. It appears only after the pass, because a hotspot that
            is on screen before the scan reaches it is a claim, not a result. */}
        {scanned && (
          <g>
            {!reduced && (
              <circle
                cx={BY_ID.hot.x}
                cy={BY_ID.hot.y}
                r={BY_ID.hot.r}
                fill="none"
                stroke="var(--coral-500)"
                strokeWidth="1"
                style={{
                  transformOrigin: `${BY_ID.hot.x}px ${BY_ID.hot.y}px`,
                  animation: "pulse-ring 2.4s var(--ease-out-expo) infinite",
                }}
              />
            )}
            <motion.g
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <rect
                x={BY_ID.hot.x - 46}
                y={BY_ID.hot.y + 20}
                width="92"
                height="19"
                rx="9.5"
                fill="rgba(255,107,87,0.12)"
                stroke="rgba(255,107,87,0.34)"
                strokeWidth="0.75"
              />
              <text
                x={BY_ID.hot.x}
                y={BY_ID.hot.y + 33}
                textAnchor="middle"
                fill="var(--coral-400)"
                fontSize="9"
                letterSpacing="0.1em"
                style={{ fontFamily: "var(--font-geist-mono), monospace" }}
              >
                UNTESTED PATH
              </text>
            </motion.g>
          </g>
        )}

        {NODES.filter((n) => n.label).map((n, i) => (
          <motion.text
            key={`l-${n.id}`}
            x={n.x}
            y={n.y - n.r - 9}
            textAnchor="middle"
            fill="var(--text-muted)"
            fontSize="9.5"
            letterSpacing="0.04em"
            style={{ fontFamily: "var(--font-geist-mono), monospace" }}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduced ? 0 : 1.15 + i * 0.07, duration: 0.5 }}
          >
            {n.label}
          </motion.text>
        ))}
      </svg>

      {/* Readout. Positioned over the figure rather than beside it so the
          number reads as an output of the graph, which is exactly what it is. */}
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={scanned ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.6, ease: EASE }}
        className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[rgba(6,8,10,0.82)] px-3.5 py-2.5 backdrop-blur-md sm:bottom-3 sm:right-3"
      >
        <div>
          <div className="eyebrow mb-0.5">Health</div>
          <div className="tnum text-[26px] leading-none text-[var(--signal-500)]">89</div>
        </div>
        <div className="h-9 w-px bg-[var(--line)]" />
        <div>
          <div className="eyebrow mb-0.5">Findings</div>
          <div className="tnum text-[26px] leading-none text-[var(--text-primary)]">62</div>
        </div>
      </motion.div>
    </div>
  );
}
