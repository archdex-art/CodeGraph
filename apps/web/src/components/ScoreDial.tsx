"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * A score as a radial arc.
 *
 * A 0–100 reading has a natural full-scale, and an arc shows the remainder — how far
 * from good this is — which a bare numeral cannot. The number stays in the middle at
 * full size because the number is still the answer; the arc is context around it.
 *
 * Deliberately a 270° arc rather than a full ring: a full ring at 100% and a full ring
 * at 99% look identical, and the gap gives the eye a start and an end to read between.
 *
 * Pure SVG — no charting dependency for one shape, and `pathLength` normalises the
 * geometry so the fill is a plain 0–1 fraction regardless of radius.
 */
export function ScoreDial({
  value,
  max = 100,
  color,
  size = 168,
  thickness = 10,
  label,
  sublabel,
}: {
  value: number;
  max?: number;
  color: string;
  size?: number;
  thickness?: number;
  label?: string;
  sublabel?: string;
}) {
  const reduced = useReducedMotion();
  const fraction = Math.max(0, Math.min(1, value / max));

  // 270° sweep, rotated so the gap sits at the bottom and the arc starts lower-left.
  const SWEEP = 0.75;
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;

  const arc = (frac: number) =>
    `M ${c} ${c} m 0 ${r} a ${r} ${r} 0 1 1 0 ${-2 * r} a ${r} ${r} 0 1 1 0 ${2 * r}`;

  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {/* The path starts at 6 o'clock and sweeps clockwise, so its 25% gap lands in the
          lower-right quadrant, centred at 135°. +45° carries that centre to 180° —
          straight down — leaving the arc symmetric about the vertical. -135° put the gap
          at the TOP, which read as a broken ring rather than a gauge. */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="rotate-[45deg]"
        aria-hidden="true"
      >
        {/* Track: the full 270° the value is measured against. */}
        <path
          d={arc(1)}
          fill="none"
          stroke="var(--ink-700)"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${circumference * SWEEP} ${circumference}`}
        />
        <motion.path
          d={arc(fraction)}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${circumference * SWEEP} ${circumference}`}
          initial={reduced ? false : { strokeDashoffset: circumference * SWEEP }}
          animate={{ strokeDashoffset: circumference * SWEEP * (1 - fraction) }}
          transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
          style={{ filter: `drop-shadow(0 0 10px color-mix(in oklab, ${color} 34%, transparent))` }}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum leading-none" style={{ color, fontSize: size * 0.26 }}>
          {Math.round(value)}
        </span>
        {label && <span className="eyebrow mt-2">{label}</span>}
        {sublabel && (
          <span className="mt-1 text-[11.5px] text-[var(--text-muted)]">{sublabel}</span>
        )}
      </div>
    </div>
  );
}
