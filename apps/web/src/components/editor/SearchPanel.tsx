"use client";

import { useState } from "react";
import { Search, Loader2, Replace, FileText } from "lucide-react";
import { searchFiles, fsRead, fsWrite } from "@/lib/api";

export function SearchPanel({
  repoId,
  onOpenResult,
}: {
  repoId: string;
  onOpenResult: (path: string, line: number) => void;
}) {
  const [q, setQ] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [results, setResults] = useState<Array<{ file: string; line: number; text: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [searched, setSearched] = useState(false);

  async function runSearch() {
    if (!q.trim()) { setResults([]); setSearched(false); return; }
    setLoading(true);
    try {
      setResults(await searchFiles(repoId, q));
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }

  async function replaceAll() {
    if (!q.trim() || !results.length) return;
    if (!confirm(`Replace all ${results.length} match(es) of "${q}" with "${replacement}" across ${new Set(results.map((r) => r.file)).size} file(s)?`)) return;
    setReplacing(true);
    try {
      const files = Array.from(new Set(results.map((r) => r.file)));
      for (const file of files) {
        const { content, binary } = await fsRead(repoId, file);
        if (binary) continue;
        const updated = content.split(q).join(replacement);
        if (updated !== content) await fsWrite(repoId, file, updated);
      }
      await runSearch();
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="p-md text-meta space-y-sm">
      <div className="text-meta uppercase tracking-wide text-[var(--text-secondary)]">Search</div>
      <div className="flex items-center gap-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-xs focus-within:border-[var(--violet-500)]/50">
        <Search className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Find in files"
          className="bg-transparent flex-1 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-secondary)]" />}
      </div>

      <button onClick={() => setShowReplace((v) => !v)} className="flex items-center gap-2xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <Replace className="w-3 h-3" /> {showReplace ? "Hide replace" : "Replace in files"}
      </button>

      {showReplace && (
        <div className="flex items-center gap-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-xs">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with"
            className="bg-transparent flex-1 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          <button onClick={replaceAll} disabled={replacing || !results.length} className="text-[var(--amber-text)] hover:text-[var(--amber-text)] disabled:opacity-30 shrink-0">
            {replacing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Replace All"}
          </button>
        </div>
      )}

      <button onClick={runSearch} className="w-full bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--line)] rounded-xs px-sm py-xs text-[var(--text-primary)]">
        Search
      </button>

      <div className="space-y-2xs max-h-[60vh] overflow-auto">
        {searched && results.length === 0 && !loading && <p className="text-[var(--text-muted)] pt-sm">No matches.</p>}
        {results.map((r, i) => (
          <button
            key={`${r.file}:${r.line}:${i}`}
            onClick={() => onOpenResult(r.file, r.line)}
            className="block w-full text-left px-sm py-xs rounded-xs hover:bg-[var(--surface-active)]"
          >
            <div className="flex items-center gap-xs text-[var(--text-secondary)]">
              <FileText className="w-3 h-3 shrink-0" />
              <span className="truncate">{r.file}</span>
              <span className="text-[var(--text-muted)] shrink-0">:{r.line}</span>
            </div>
            <div className="text-[var(--text-secondary)] truncate pl-md font-mono">{r.text}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
