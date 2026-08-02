"use client";

import { useEffect, useState } from "react";
import { Search, Loader2, ArrowUpRight, ArrowDownRight, Boxes, Sparkles, Copy, Check, AlertTriangle, Skull, Radius } from "lucide-react";
import { intelSearch, intelRelation, intelContext, intelAudit } from "@/lib/api";
import type { AIContext, CodeSymbol, SymbolGraph } from "@/lib/types";

const KIND_COLOR: Record<string, string> = {
  function: "#60a5fa", method: "#22d3ee", class: "#a78bfa", interface: "#f472b6",
  type: "#f472b6", enum: "#fbbf24", struct: "#a78bfa", constant: "#94a3b8", component: "#34d399",
};
const kc = (k: string) => KIND_COLOR[k] || "#9ca3af";

type Rel = "callers" | "callees" | "members" | "impact";

export function CodeIntelPanel({ repoId, graph }: { repoId: string; graph: SymbolGraph }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CodeSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CodeSymbol | null>(null);
  const [rel, setRel] = useState<Rel>("callees");
  const [relResults, setRelResults] = useState<CodeSymbol[]>([]);
  const [relLoading, setRelLoading] = useState(false);

  // debounced search
  useEffect(() => {
    // Clearing the query cancels the in-flight search, which skips its own
    // `finally` — so the spinner has to be cleared here or it never stops.
    if (!q.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await intelSearch(repoId, q);
        if (!cancelled) setResults(r);
      } catch {
        if (!cancelled) setResults([]); // don't strand stale results on error
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, repoId]);

  useEffect(() => {
    if (!selected) { setRelResults([]); return; }
    setRelLoading(true);
    let cancelled = false;
    intelRelation(repoId, rel, selected.id)
      .then((r) => { if (!cancelled) setRelResults(r); })
      .catch(() => { if (!cancelled) setRelResults([]); }) // clear stale relations on error
      .finally(() => { if (!cancelled) setRelLoading(false); });
    return () => { cancelled = true; };
  }, [selected, rel, repoId]);

  if (!graph || graph.symbols.length === 0) {
    return <p className="text-meta text-gray-600 border border-dashed border-white/10 rounded-lg p-xl text-center">No symbols extracted (unsupported languages, or re-index needed).</p>;
  }

  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center gap-md text-meta text-gray-500">
        <span className="text-gray-300 font-semibold">{graph.stats.symbols.toLocaleString()}</span> symbols
        <span className="text-gray-300 font-semibold">{graph.stats.edges.toLocaleString()}</span> edges
        <span className="text-gray-300 font-semibold">{graph.stats.resolvedCalls.toLocaleString()}</span> resolved calls
      </div>

      {/* The detail pane is the primary term — docstring, signature, relation
          list — so it takes the 1.618 track and the search column takes 1. */}
      <div className="split-phi-rev">
        {/* Search + results */}
        {/* min-w-0: a grid item's default `min-width:auto` lets unbreakable content
            (a docstring's ==== rule, a long path) widen the track past the card. */}
        <div className="min-w-0 rounded-lg border border-white/5 bg-white/[0.02] p-md">
          <div className="relative mb-md">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search symbols, tags (auth, db, http)…"
              className="w-full rounded-md bg-[#0a0a0a] border border-white/10 pl-xl pr-md py-sm text-meta text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
            />
            {loading && <Loader2 className="w-4 h-4 text-gray-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
          </div>
          <div className="max-h-[360px] overflow-auto divide-y divide-white/5">
            {results.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s)}
                className={`w-full text-left py-sm px-2xs hover:bg-white/[0.03] transition-colors ${selected?.id === s.id ? "bg-white/[0.04]" : ""}`}
              >
                <div className="flex items-center gap-sm">
                  <span className="text-micro font-mono px-xs py-2xs rounded-xs" style={{ color: kc(s.kind), background: kc(s.kind) + "22" }}>{s.kind}</span>
                  <span className="text-meta text-white truncate">{s.name}</span>
                  {s.exported && <span className="text-micro text-emerald-400">export</span>}
                </div>
                <div className="text-micro text-gray-600 font-mono truncate">{s.file}:{s.line}</div>
                {s.tags.length > 0 && <div className="text-micro text-purple-400/70 mt-2xs">{s.tags.join(" · ")}</div>}
              </button>
            ))}
            {q && !loading && results.length === 0 && <p className="text-meta text-gray-600 py-md text-center">No matches.</p>}
            {!q && <p className="text-meta text-gray-600 py-md text-center">Type to search the symbol graph.</p>}
          </div>
        </div>

        {/* Selected symbol + relationships */}
        <div className="min-w-0 rounded-lg border border-white/5 bg-white/[0.02] p-md">
          {selected ? (
            <>
              <div className="mb-md">
                <div className="flex items-center gap-sm">
                  <span className="text-micro font-mono px-xs py-2xs rounded-xs" style={{ color: kc(selected.kind), background: kc(selected.kind) + "22" }}>{selected.kind}</span>
                  <span className="text-h3 text-white font-semibold [overflow-wrap:anywhere]">{selected.name}</span>
                </div>
                <div className="text-micro text-gray-600 font-mono mt-2xs break-all">{selected.file}:{selected.line}</div>
                {selected.doc && (
                  <p className="text-meta text-gray-400 mt-sm italic whitespace-pre-wrap [overflow-wrap:anywhere] max-h-40 overflow-y-auto">
                    {selected.doc}
                  </p>
                )}
                <code className="block text-meta text-cyan-300/80 font-mono mt-sm bg-black/30 rounded-md p-sm [overflow-wrap:anywhere]">{selected.signature}</code>
                <div className="flex gap-md text-micro text-gray-500 mt-sm">
                  <span>callers <b className="text-gray-300">{selected.fanIn}</b></span>
                  <span>callees <b className="text-gray-300">{selected.fanOut}</b></span>
                </div>
              </div>
              <div className="inline-flex rounded-md border border-white/10 bg-[#0a0a0a] p-2xs text-meta mb-sm">
                {(["callees", "callers", "members", "impact"] as Rel[]).map((r) => (
                  <button key={r} onClick={() => setRel(r)} className={`px-sm py-2xs rounded-sm capitalize ${rel === r ? "bg-white text-black" : "text-gray-400 hover:text-white"}`}>
                    {r === "callees" && <ArrowDownRight className="w-3 h-3 inline mr-2xs" />}
                    {r === "callers" && <ArrowUpRight className="w-3 h-3 inline mr-2xs" />}
                    {r === "members" && <Boxes className="w-3 h-3 inline mr-2xs" />}
                    {r === "impact" && <Radius className="w-3 h-3 inline mr-2xs" />}
                    {r}
                  </button>
                ))}
              </div>
              <div className="max-h-[240px] overflow-auto divide-y divide-white/5">
                {relLoading ? (
                  <div className="flex items-center gap-sm text-gray-500 text-meta py-md justify-center"><Loader2 className="w-3 h-3 animate-spin" /> loading…</div>
                ) : relResults.length === 0 ? (
                  <p className="text-meta text-gray-600 py-md text-center">None.</p>
                ) : (
                  relResults.map((s) => (
                    <button key={s.id} onClick={() => setSelected(s)} className="w-full text-left py-xs px-2xs hover:bg-white/[0.03] min-w-0">
                      <span className="text-meta text-gray-200">{s.name}</span>
                      <span className="text-micro text-gray-600 font-mono ml-sm [overflow-wrap:anywhere]">{s.file}:{s.line}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <p className="text-meta text-gray-600 py-xl text-center">Select a symbol to inspect its call graph, members, and impact set.</p>
          )}
        </div>
      </div>

      <ContextGenerator repoId={repoId} />
      <AuditRow repoId={repoId} />
    </div>
  );
}

function ContextGenerator({ repoId }: { repoId: string }) {
  const [task, setTask] = useState("");
  const [ctx, setCtx] = useState<AIContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run() {
    if (!task.trim()) return;
    setLoading(true);
    try { setCtx(await intelContext(repoId, task)); } finally { setLoading(false); }
  }

  return (
    <div className="rounded-lg border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.06] to-transparent p-md">
      <h3 className="text-h3 text-white flex items-center gap-sm mb-2xs"><Sparkles className="w-4 h-4 text-purple-300" /> Graph-RAG AI Context</h3>
      <p className="max-w-note text-meta text-gray-500 mb-md">Describe a task; CodeGraph assembles a token-budgeted, structurally-relevant prompt from the symbol graph.</p>
      <div className="flex flex-col sm:flex-row gap-sm">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="e.g. optimize authentication and session handling"
          className="flex-1 rounded-md bg-[#0a0a0a] border border-white/10 px-md py-sm text-meta text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
        />
        <button onClick={run} disabled={loading || !task.trim()} className="flex items-center justify-center gap-sm bg-white text-black px-lg py-sm rounded-md text-meta font-semibold hover:bg-gray-200 disabled:opacity-40">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Build
        </button>
      </div>
      {ctx && (
        <div className="mt-md">
          <div className="flex items-center justify-between text-meta text-gray-500 mb-2xs">
            <span>{ctx.slices.length} symbols · ~{ctx.tokenEstimate} tokens{ctx.truncated ? " · budget-capped" : ""}</span>
            <button onClick={() => { navigator.clipboard.writeText(ctx.prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="flex items-center gap-2xs hover:text-white">
              {copied ? <><Check className="w-3 h-3 text-emerald-400" /> copied</> : <><Copy className="w-3 h-3" /> copy prompt</>}
            </button>
          </div>
          <pre className="text-meta text-gray-300 bg-black/40 rounded-md p-md max-h-[300px] overflow-auto whitespace-pre-wrap font-mono">{ctx.prompt}</pre>
        </div>
      )}
    </div>
  );
}

function AuditRow({ repoId }: { repoId: string }) {
  const [tab, setTab] = useState<"cycles" | "deadcode" | "hubs" | null>(null);
  const [data, setData] = useState<{ results?: CodeSymbol[]; cycles?: string[][] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(op: "cycles" | "deadcode" | "hubs") {
    setTab(op); setLoading(true);
    try { setData(await intelAudit(repoId, op)); } finally { setLoading(false); }
  }

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-md">
      <div className="flex flex-wrap gap-sm mb-md">
        <AuditBtn active={tab === "cycles"} onClick={() => run("cycles")} icon={<AlertTriangle className="w-3.5 h-3.5" />} label="Circular deps" />
        <AuditBtn active={tab === "deadcode"} onClick={() => run("deadcode")} icon={<Skull className="w-3.5 h-3.5" />} label="Dead code" />
        <AuditBtn active={tab === "hubs"} onClick={() => run("hubs")} icon={<Radius className="w-3.5 h-3.5" />} label="Hub symbols" />
      </div>
      {loading ? (
        <div className="flex items-center gap-sm text-gray-500 text-meta py-md"><Loader2 className="w-3 h-3 animate-spin" /> analyzing…</div>
      ) : !tab ? (
        <p className="max-w-note text-meta text-gray-600">Run graph audits: circular call chains, unreferenced code, and connectivity hubs.</p>
      ) : tab === "cycles" ? (
        (data?.cycles?.length ?? 0) === 0 ? <p className="text-meta text-emerald-400">No call cycles detected.</p> :
        <ul className="text-meta text-gray-300 space-y-2xs max-h-[180px] overflow-auto">{data!.cycles!.map((c, i) => <li key={i} className="font-mono text-amber-300">{c.join(" → ")} → …</li>)}</ul>
      ) : (
        (data?.results?.length ?? 0) === 0 ? <p className="text-meta text-emerald-400">Nothing found.</p> :
        <ul className="text-meta text-gray-300 space-y-2xs max-h-[180px] overflow-auto">{data!.results!.map((s) => <li key={s.id}><span className="text-white">{s.name}</span> <span className="text-gray-600 font-mono">{s.file}:{s.line}</span>{tab === "hubs" && <span className="text-gray-500"> · {s.fanIn + s.fanOut} conns</span>}</li>)}</ul>
      )}
    </div>
  );
}

function AuditBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-xs text-meta px-md py-xs rounded-md border transition-colors ${active ? "bg-white text-black border-white" : "border-white/10 text-gray-400 hover:text-white"}`}>
      {icon}{label}
    </button>
  );
}
