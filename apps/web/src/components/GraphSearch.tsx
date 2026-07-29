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
    <div className="relative w-full max-w-xs">
      <div className="flex items-center gap-1.5 bg-[#0a0a0a] border border-white/10 rounded-lg px-3 py-1.5 focus-within:border-purple-500/50">
        <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches.length) pick(matches[0].id);
            if (e.key === "Escape") { setQ(""); setOpen(false); }
          }}
          placeholder={placeholder}
          className="bg-transparent flex-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none min-w-0"
        />
        {q && (
          <button onClick={() => { setQ(""); setOpen(false); }} className="text-gray-500 hover:text-white shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && q && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-white/10 bg-[#111113] shadow-2xl">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-600">No matches.</p>
          ) : (
            matches.map((n) => (
              <button
                key={n.id}
                onClick={() => pick(n.id)}
                className="block w-full text-left px-3 py-1.5 hover:bg-white/10"
              >
                <div className="text-xs text-gray-200 truncate">{n.label}</div>
                {n.subtitle && <div className="text-[10px] text-gray-600 truncate">{n.subtitle}</div>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
