"use client";

import type { TierFilter, TieredFindings } from "@/lib/findings";
import { GROUP_META } from "@/lib/findings";

/**
 * The one control that decides how much of a findings list you are being shown.
 *
 * Every chip carries its count, including the ones you are not looking at: the number
 * that matters most on this repository is the 100 you cannot see, and a filter that
 * hides the size of what it filtered is how a list becomes quietly incomplete.
 */
const LABEL: Record<TierFilter, { full: string; compact: string }> = {
  default: { full: "High + Medium", compact: "High + Med" },
  high: { full: GROUP_META.high.label, compact: "High" },
  medium: { full: GROUP_META.medium.label, compact: "Med" },
  low: { full: GROUP_META.low.label, compact: "Low" },
  accepted: { full: GROUP_META.accepted.label, compact: "Accepted" },
  all: { full: "Everything", compact: "All" },
};

export function TierFilterBar({
  tiered,
  value,
  onChange,
  compact = false,
}: {
  tiered: TieredFindings;
  value: TierFilter;
  onChange: (next: TierFilter) => void;
  compact?: boolean;
}) {
  // Only the tiers this index actually produced — a chip reading "Accepted 0" invites a
  // click that changes nothing.
  const options: Array<{ key: TierFilter; count: number }> = [
    { key: "default", count: tiered.groups.reduce((n, g) => (g.key === "high" || g.key === "medium" ? n + g.issues.length : n), 0) },
    ...tiered.groups.map((g) => ({ key: g.key as TierFilter, count: g.issues.length })),
    { key: "all", count: tiered.total },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2xs" role="group" aria-label="Filter findings by confidence">
      {options.map(({ key, count }) => {
        const selected = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(key)}
            className={`cursor-pointer rounded-xs border px-xs py-hair text-micro transition-colors duration-200 ${
              selected
                ? "border-[var(--accent-fill)]/50 bg-[var(--accent-fill)]/10 text-[var(--accent-text)]"
                : "border-[var(--line)] text-[var(--text-muted)] hover:border-line-strong hover:text-[var(--text-primary)]"
            }`}
          >
            {compact ? LABEL[key].compact : LABEL[key].full} <span className="tnum">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
