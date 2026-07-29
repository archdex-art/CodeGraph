"use client";

import { useEffect, useState } from "react";
import { Folder, Home, Loader2, X, ArrowUp, Check } from "lucide-react";
import { browseDir, type BrowseEntry } from "@/lib/api";

export function FolderBrowser({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(initialPath?.trim() || null);
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    browseDir(path || undefined)
      .then((res) => {
        if (cancelled) return;
        setPath(res.path);
        setParent(res.parent);
        setHome(res.home);
        setEntries(res.entries);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to list directory");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8" onClick={onClose}>
      <div
        className="bg-[#111113] border border-white/10 rounded-xl max-w-lg w-full max-h-[75vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-sm font-semibold text-white">Browse for folder</span>
          <button onClick={onClose} className="text-gray-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10 bg-white/[0.02]">
          <button
            onClick={() => home && setPath(home)}
            disabled={!home || loading}
            title="Home"
            className="text-gray-400 hover:text-white disabled:opacity-40 shrink-0"
          >
            <Home className="w-4 h-4" />
          </button>
          <button
            onClick={() => parent && setPath(parent)}
            disabled={!parent || loading}
            title="Up one level"
            className="text-gray-400 hover:text-white disabled:opacity-40 shrink-0"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <span className="flex-1 text-xs font-mono text-gray-300 truncate" title={path || ""}>
            {path || "…"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto min-h-[240px]">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="text-sm text-rose-400 px-4 py-4 break-all">{error}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-600 px-4 py-4">No subfolders here.</p>
          ) : (
            <ul className="py-1">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    onClick={() => setPath(entry.path)}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white text-left"
                  >
                    <Folder className="w-4 h-4 text-purple-400 shrink-0" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-white/10">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-white px-3 py-2">
            Cancel
          </button>
          <button
            onClick={() => path && onSelect(path)}
            disabled={!path || loading || !!error}
            className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check className="w-4 h-4" /> Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
