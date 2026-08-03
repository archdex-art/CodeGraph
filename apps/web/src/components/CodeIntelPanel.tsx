"use client";

import { useEffect, useState } from "react";
import { Search, Loader2, ArrowUpRight, ArrowDownRight, Boxes, Sparkles, Copy, Check, AlertTriangle, Skull, Radius } from "lucide-react";
import { intelSearch, intelRelation, intelContext, intelAudit } from "@/lib/api";
import type { AIContext, CodeSymbol, SymbolGraph } from "@/lib/types";

/**
 * The kind chip, in tokens.
 *
 * The palette has four hues and no blue/cyan/pink, so the nine kinds collapse onto
 * the families the vocabulary can actually express — nominal types violet, structural
 * types coral, enums amber — and the two kinds that are the default case (function,
 * method) go neutral rather than borrowing a hue that means something else. The chip
 * fill is mixed from its own text colour, so a light theme gets a pale wash under
 * dark text instead of a dark wash under bright text.
 */
const KIND_COLOR: Record<string, string> = {
  function: "var(--text-primary)", method: "var(--text-primary)", class: "var(--violet-text)",
  interface: "var(--coral-text)", type: "var(--coral-text)", enum: "var(--amber-text)",
  struct: "var(--violet-text)", constant: "var(--text-secondary)", component: "var(--accent-text)",
};
const kc = (k: string) => KIND_COLOR[k] || "var(--text-secondary)";
const kindChip = (k: string) => ({
  color: kc(k),
  background: `color-mix(in srgb, ${kc(k)} 14%, transparent)`,
});

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
    return <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-lg p-xl text-center">No symbols extracted (unsupported languages, or re-index needed).</p>;
  }

  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center gap-md text-meta text-[var(--text-secondary)]">
        <span className="text-[var(--text-primary)] font-semibold">{graph.stats.symbols.toLocaleString()}</span> symbols
        <span className="text-[var(--text-primary)] font-semibold">{graph.stats.edges.toLocaleString()}</span> edges
        <span className="text-[var(--text-primary)] font-semibold">{graph.stats.resolvedCalls.toLocaleString()}</span> resolved calls
      </div>

      {/* The detail pane is the primary term — docstring, signature, relation
          list — so it takes the 1.618 track and the search column takes 1. */}
      <div className="split-phi-rev">
        {/* Search + results */}
        {/* min-w-0: a grid item's default `min-width:auto` lets unbreakable content
            (a docstring's ==== rule, a long path) widen the track past the card. */}
        <div className="min-w-0 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
          <div className="relative mb-md">
            <Search className="w-4 h-4 text-[var(--text-secondary)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search symbols, tags (auth, db, http)…"
              className="w-full rounded-md bg-[var(--surface-2)] border border-[var(--line)] pl-xl pr-md py-sm text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--violet-500)]/50"
            />
            {loading && <Loader2 className="w-4 h-4 text-[var(--text-secondary)] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
          </div>
          <div className="max-h-[360px] overflow-auto divide-y divide-[var(--line-soft)]">
            {results.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s)}
                className={`w-full text-left py-sm px-2xs hover:bg-[var(--surface-hover)] transition-colors ${selected?.id === s.id ? "bg-[var(--surface-active)]" : ""}`}
              >
                <div className="flex items-center gap-sm">
                  <span className="text-micro font-mono px-xs py-2xs rounded-xs" style={kindChip(s.kind)}>{s.kind}</span>
                  <span className="text-meta text-[var(--text-primary)] truncate">{s.name}</span>
                  {s.exported && <span className="text-micro text-[var(--accent-text)]">export</span>}
                </div>
                <div className="text-micro text-[var(--text-muted)] font-mono truncate">{s.file}:{s.line}</div>
                {s.tags.length > 0 && <div className="text-micro text-[var(--violet-text)] mt-2xs">{s.tags.join(" · ")}</div>}
              </button>
            ))}
            {q && !loading && results.length === 0 && <p className="text-meta text-[var(--text-muted)] py-md text-center">No matches.</p>}
            {!q && <p className="text-meta text-[var(--text-muted)] py-md text-center">Type to search the symbol graph.</p>}
          </div>
        </div>

        {/* Selected symbol + relationships */}
        <div className="min-w-0 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
          {selected ? (
            <>
              <div className="mb-md">
                <div className="flex items-center gap-sm">
                  <span className="text-micro font-mono px-xs py-2xs rounded-xs" style={kindChip(selected.kind)}>{selected.kind}</span>
                  <span className="text-h3 text-[var(--text-primary)] font-semibold [overflow-wrap:anywhere]">{selected.name}</span>
                </div>
                <div className="text-micro text-[var(--text-muted)] font-mono mt-2xs break-all">{selected.file}:{selected.line}</div>
                {selected.doc && (
                  <p className="text-meta text-[var(--text-secondary)] mt-sm italic whitespace-pre-wrap [overflow-wrap:anywhere] max-h-40 overflow-y-auto">
                    {selected.doc}
                  </p>
                )}
                <code className="block text-meta text-[var(--accent-text)] font-mono mt-sm bg-[var(--surface-inset)] rounded-md p-sm [overflow-wrap:anywhere]">{selected.signature}</code>
                <div className="flex gap-md text-micro text-[var(--text-secondary)] mt-sm">
                  <span>callers <b className="text-[var(--text-primary)]">{selected.fanIn}</b></span>
                  <span>callees <b className="text-[var(--text-primary)]">{selected.fanOut}</b></span>
                </div>
              </div>
              <div className="inline-flex rounded-md border border-[var(--line)] bg-[var(--surface-2)] p-2xs text-meta mb-sm">
                {(["callees", "callers", "members", "impact"] as Rel[]).map((r) => (
                  <button key={r} onClick={() => setRel(r)} className={`px-sm py-2xs rounded-sm capitalize ${rel === r ? "bg-[var(--accent-fill)] text-[var(--accent-on-fill)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                    {r === "callees" && <ArrowDownRight className="w-3 h-3 inline mr-2xs" />}
                    {r === "callers" && <ArrowUpRight className="w-3 h-3 inline mr-2xs" />}
                    {r === "members" && <Boxes className="w-3 h-3 inline mr-2xs" />}
                    {r === "impact" && <Radius className="w-3 h-3 inline mr-2xs" />}
                    {r}
                  </button>
                ))}
              </div>
              <div className="max-h-[240px] overflow-auto divide-y divide-[var(--line-soft)]">
                {relLoading ? (
                  <div className="flex items-center gap-sm text-[var(--text-secondary)] text-meta py-md justify-center"><Loader2 className="w-3 h-3 animate-spin" /> loading…</div>
                ) : relResults.length === 0 ? (
                  <p className="text-meta text-[var(--text-muted)] py-md text-center">None.</p>
                ) : (
                  relResults.map((s) => (
                    <button key={s.id} onClick={() => setSelected(s)} className="w-full text-left py-xs px-2xs hover:bg-[var(--surface-hover)] min-w-0">
                      <span className="text-meta text-[var(--text-primary)]">{s.name}</span>
                      <span className="text-micro text-[var(--text-muted)] font-mono ml-sm [overflow-wrap:anywhere]">{s.file}:{s.line}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <p className="text-meta text-[var(--text-muted)] py-xl text-center">Select a symbol to inspect its call graph, members, and impact set.</p>
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
    <div className="rounded-lg border border-[var(--violet-500)]/20 bg-gradient-to-br from-[var(--violet-500)]/[0.06] to-transparent p-md">
      <h3 className="text-h3 text-[var(--text-primary)] flex items-center gap-sm mb-2xs"><Sparkles className="w-4 h-4 text-[var(--violet-text)]" /> Graph-RAG AI Context</h3>
      <p className="max-w-note text-meta text-[var(--text-secondary)] mb-md">Describe a task; CodeGraph assembles a token-budgeted, structurally-relevant prompt from the symbol graph.</p>
      <div className="flex flex-col sm:flex-row gap-sm">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="e.g. optimize authentication and session handling"
          className="flex-1 rounded-md bg-[var(--surface-2)] border border-[var(--line)] px-md py-sm text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--violet-500)]/50"
        />
        <button onClick={run} disabled={loading || !task.trim()} className="flex items-center justify-center gap-sm bg-[var(--accent-fill)] text-[var(--accent-on-fill)] px-lg py-sm rounded-md text-meta font-semibold hover:bg-[var(--signal-400)] disabled:opacity-40">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Build
        </button>
      </div>
      {ctx && (
        <div className="mt-md">
          <div className="flex items-center justify-between text-meta text-[var(--text-secondary)] mb-2xs">
            <span>{ctx.slices.length} symbols · ~{ctx.tokenEstimate} tokens{ctx.truncated ? " · budget-capped" : ""}</span>
            <button onClick={() => { navigator.clipboard.writeText(ctx.prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="flex items-center gap-2xs hover:text-[var(--text-primary)]">
              {copied ? <><Check className="w-3 h-3 text-[var(--accent-text)]" /> copied</> : <><Copy className="w-3 h-3" /> copy prompt</>}
            </button>
          </div>
          <pre className="text-meta text-[var(--text-primary)] bg-[var(--surface-inset)] rounded-md p-md max-h-[300px] overflow-auto whitespace-pre-wrap font-mono">{ctx.prompt}</pre>
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
    <div className="rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
      <div className="flex flex-wrap gap-sm mb-md">
        <AuditBtn active={tab === "cycles"} onClick={() => run("cycles")} icon={<AlertTriangle className="w-3.5 h-3.5" />} label="Circular deps" />
        <AuditBtn active={tab === "deadcode"} onClick={() => run("deadcode")} icon={<Skull className="w-3.5 h-3.5" />} label="Dead code" />
        <AuditBtn active={tab === "hubs"} onClick={() => run("hubs")} icon={<Radius className="w-3.5 h-3.5" />} label="Hub symbols" />
      </div>
      {loading ? (
        <div className="flex items-center gap-sm text-[var(--text-secondary)] text-meta py-md"><Loader2 className="w-3 h-3 animate-spin" /> analyzing…</div>
      ) : !tab ? (
        <p className="max-w-note text-meta text-[var(--text-muted)]">Run graph audits: circular call chains, unreferenced code, and connectivity hubs.</p>
      ) : tab === "cycles" ? (
        (data?.cycles?.length ?? 0) === 0 ? <p className="text-meta text-[var(--accent-text)]">No call cycles detected.</p> :
        <ul className="text-meta text-[var(--text-primary)] space-y-2xs max-h-[180px] overflow-auto">{data!.cycles!.map((c, i) => <li key={i} className="font-mono text-[var(--amber-text)]">{c.join(" → ")} → …</li>)}</ul>
      ) : (
        (data?.results?.length ?? 0) === 0 ? <p className="text-meta text-[var(--accent-text)]">Nothing found.</p> :
        <ul className="text-meta text-[var(--text-primary)] space-y-2xs max-h-[180px] overflow-auto">{data!.results!.map((s) => <li key={s.id}><span className="text-[var(--text-primary)]">{s.name}</span> <span className="text-[var(--text-muted)] font-mono">{s.file}:{s.line}</span>{tab === "hubs" && <span className="text-[var(--text-secondary)]"> · {s.fanIn + s.fanOut} conns</span>}</li>)}</ul>
      )}
    </div>
  );
}

function AuditBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-xs text-meta px-md py-xs rounded-md border transition-colors ${active ? "bg-[var(--accent-fill)] text-[var(--accent-on-fill)] border-[var(--accent-fill)]" : "border-[var(--line)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
      {icon}{label}
    </button>
  );
}
