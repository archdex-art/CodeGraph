"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

export interface SearchableNode {
  id: string;
  label: string;
  subtitle?: string;
}

/**
 * Search-to-focus bar shared by NodeGraph-backed views (Architecture, Network)
 * and reimplemented natively for CirclePackView (different node shape/API).
 * Matches by label/subtitle substring, case-insensitive; clicking (or Enter,
 * for the top match) hands the matched node id to `onFocus`.
 */
export function GraphSearch({
  nodes,
  onFocus,
  placeholder = "Search files/nodes…",
}: {
  nodes: SearchableNode[];
  onFocus: (id: string) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return nodes
      .filter((n) => n.label.toLowerCase().includes(query) || n.subtitle?.toLowerCase().includes(query))
      .slice(0, 30);
  }, [nodes, q]);

  function pick(id: string) {
    onFocus(id);
    setOpen(false);
  }

  return (
    <div className="relative w-full max-w-rail">
      {/* The WRAPPER carries the focus affordance, not the input.

          `:focus-visible` in `globals.css` is unlayered, so its 2px lime outline
          outranks Tailwind's `focus:outline-none` (which lives in `@layer utilities`)
          and drew a second, brighter ring inside this one — two rings on one control,
          in two different accent hues. `focus-visible:outline-none` here is at the
          same unlayered specificity via the arbitrary variant, so it actually lands.
          The affordance is not removed, only de-duplicated: the border goes to full
          violet and gains a soft ring, which is a clearer focus state than the outline
          it replaces and keeps the control keyboard-legible. */}
      <div className="flex items-center gap-xs rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-sm py-xs transition-[border-color,box-shadow] duration-200 focus-within:border-[var(--violet-500)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--violet-500)_18%,transparent)]">
        <Search className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches.length) pick(matches[0].id);
            if (e.key === "Escape") { setQ(""); setOpen(false); }
          }}
          placeholder={placeholder}
          data-focus-ring="none"
          className="min-w-0 flex-1 bg-transparent text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
        />
        {q && (
          <button onClick={() => { setQ(""); setOpen(false); }} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && q && (
        <div className="absolute z-20 mt-2xs w-full max-h-72 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-2)] shadow-2xl">
          {matches.length === 0 ? (
            <p className="px-sm py-sm text-meta text-[var(--text-muted)]">No matches.</p>
          ) : (
            matches.map((n) => (
              <button
                key={n.id}
                onClick={() => pick(n.id)}
                className="block w-full text-left px-sm py-xs hover:bg-[var(--surface-active)]"
              >
                <div className="text-meta text-[var(--text-primary)] truncate">{n.label}</div>
                {n.subtitle && <div className="text-micro text-[var(--text-muted)] truncate">{n.subtitle}</div>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
