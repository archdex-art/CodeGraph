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
    <div className="p-3 text-xs space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">Search</div>
      <div className="flex items-center gap-1.5 bg-[#0a0a0a] border border-white/10 rounded px-2 py-1.5 focus-within:border-purple-500/50">
        <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Find in files"
          className="bg-transparent flex-1 text-gray-200 placeholder-gray-600 focus:outline-none"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
      </div>

      <button onClick={() => setShowReplace((v) => !v)} className="flex items-center gap-1 text-gray-500 hover:text-white">
        <Replace className="w-3 h-3" /> {showReplace ? "Hide replace" : "Replace in files"}
      </button>

      {showReplace && (
        <div className="flex items-center gap-1.5 bg-[#0a0a0a] border border-white/10 rounded px-2 py-1.5">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with"
            className="bg-transparent flex-1 text-gray-200 placeholder-gray-600 focus:outline-none"
          />
          <button onClick={replaceAll} disabled={replacing || !results.length} className="text-amber-400 hover:text-amber-300 disabled:opacity-30 shrink-0">
            {replacing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Replace All"}
          </button>
        </div>
      )}

      <button onClick={runSearch} className="w-full bg-white/5 hover:bg-white/10 border border-white/10 rounded px-2 py-1.5 text-gray-300">
        Search
      </button>

      <div className="space-y-1 max-h-[60vh] overflow-auto">
        {searched && results.length === 0 && !loading && <p className="text-gray-600 pt-2">No matches.</p>}
        {results.map((r, i) => (
          <button
            key={`${r.file}:${r.line}:${i}`}
            onClick={() => onOpenResult(r.file, r.line)}
            className="block w-full text-left px-2 py-1.5 rounded hover:bg-white/5"
          >
            <div className="flex items-center gap-1.5 text-gray-400">
              <FileText className="w-3 h-3 shrink-0" />
              <span className="truncate">{r.file}</span>
              <span className="text-gray-600 shrink-0">:{r.line}</span>
            </div>
            <div className="text-gray-500 truncate pl-4 font-mono">{r.text}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
