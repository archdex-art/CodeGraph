"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, ArrowUpRight, ArrowDownRight, Boxes, Sparkles, Copy, Check, AlertTriangle, Skull, Radius, Crosshair, X } from "lucide-react";
import { intelSearch, intelRelation, intelContext, intelAudit } from "@/lib/api";
import { useSharedState } from "@/lib/ui-state";
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

/**
 * Query state is keyed by repository and outlives the mount.
 *
 * Sections are routes, so opening the editor to look at a hit and coming back
 * used to clear the query, the selection and the results. `EMPTY` is a shared
 * constant because the shared store compares snapshots by identity — a fresh
 * `[]` per render would look like a change on every read.
 */
const EMPTY: CodeSymbol[] = [];
const key = (repoId: string, part: string) => `intel:${repoId}:${part}`;

/**
 * A node picked in one of the graph views: a file path, a directory, or a module id.
 *
 * Three id vocabularies meet here. Viz file/dir nodes are posix paths (`buildVizGraph`),
 * module nodes are top-level dir prefixes with a `(root)` sentinel for files that live at
 * the repository root (`buildModuleGraph`), and symbol `file` fields carry the host
 * separator. Normalising in one predicate is what lets all three graph views drive the
 * same panel without each learning the others' conventions.
 */
const posix = (p: string) => p.split("\\").join("/");

/** The module-graph sentinel for "files directly at the repository root". */
const ROOT_MODULE = "(root)";

export function inScope(file: string, scope: string): boolean {
  const f = posix(file);
  if (scope === ROOT_MODULE) return !f.includes("/");
  const s = posix(scope);
  return s === "." || f === s || f.startsWith(`${s}/`);
}

export function CodeIntelPanel({
  repoId,
  graph,
  scope = null,
  onClearScope,
}: {
  repoId: string;
  graph: SymbolGraph;
  /** File or directory selected in a graph view; narrows the result list. */
  scope?: string | null;
  onClearScope?: () => void;
}) {
  const [q, setQ] = useSharedState(key(repoId, "q"), "");
  const [searchResults, setResults] = useSharedState<CodeSymbol[]>(key(repoId, "results"), EMPTY);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useSharedState<CodeSymbol | null>(key(repoId, "selected"), null);
  const [rel, setRel] = useSharedState<Rel>(key(repoId, "rel"), "callees");
  const [relResults, setRelResults] = useSharedState<CodeSymbol[]>(key(repoId, "relResults"), EMPTY);
  const [relLoading, setRelLoading] = useState(false);

  /**
   * Scoped browsing is a LOCAL filter, not a second endpoint. The symbol graph is
   * already in the client (the layout fetched it), so narrowing to the file you just
   * clicked is a array filter — and going to the server would make clicking a node
   * feel slower than typing its name, which is the whole thing this replaced.
   */
  const scopedSymbols = useMemo(() => {
    if (!scope) return EMPTY;
    const needle = q.trim().toLowerCase();
    return graph.symbols
      .filter((s) => inScope(s.file, scope))
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.tags.some((t) => t.includes(needle)))
      .slice(0, 300);
  }, [scope, q, graph.symbols]);

  const results = scope ? scopedSymbols : searchResults;

  // debounced search — only when unscoped; a scope filters in memory.
  useEffect(() => {
    if (scope) { setLoading(false); return; }
    // Clearing the query cancels the in-flight search, which skips its own
    // `finally` — so the spinner has to be cleared here or it never stops.
    if (!q.trim()) { setResults(EMPTY); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await intelSearch(repoId, q);
        if (!cancelled) setResults(r);
      } catch {
        if (!cancelled) setResults(EMPTY); // don't strand stale results on error
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, repoId, scope, setResults]);

  useEffect(() => {
    if (!selected) { setRelResults(EMPTY); return; }
    setRelLoading(true);
    let cancelled = false;
    intelRelation(repoId, rel, selected.id)
      .then((r) => { if (!cancelled) setRelResults(r); })
      .catch(() => { if (!cancelled) setRelResults(EMPTY); }) // clear stale relations on error
      .finally(() => { if (!cancelled) setRelLoading(false); });
    return () => { cancelled = true; };
  }, [selected, rel, repoId, setRelResults]);

  if (!graph || graph.symbols.length === 0) {
    return <p className="text-meta text-[var(--text-muted)] border border-dashed border-[var(--line)] rounded-lg p-xl text-center">No symbols extracted (unsupported languages, or re-index needed).</p>;
  }

  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center gap-x-md gap-y-2xs text-meta text-[var(--text-secondary)]">
        <span className="whitespace-nowrap">
          <b className="font-semibold text-[var(--text-primary)]">{graph.stats.symbols.toLocaleString()}</b> symbols
        </span>
        <span className="whitespace-nowrap">
          <b className="font-semibold text-[var(--text-primary)]">{graph.stats.edges.toLocaleString()}</b> edges
        </span>
        <span className="whitespace-nowrap">
          <b className="font-semibold text-[var(--text-primary)]">{graph.stats.resolvedCalls.toLocaleString()}</b> resolved calls
        </span>
      </div>

      {/* The detail pane is the primary term — docstring, signature, relation
          list — so it takes the 1.618 track and the search column takes 1. */}
      <div className="split-phi-rev">
        {/* Search + results */}
        {/* min-w-0: a grid item's default `min-width:auto` lets unbreakable content
            (a docstring's ==== rule, a long path) widen the track past the card. */}
        <div className="min-w-0 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
          {scope && (
            <div className="mb-sm flex items-center gap-sm rounded-md border border-[var(--violet-500)]/35 bg-[color-mix(in_srgb,var(--violet-text)_10%,transparent)] px-sm py-xs">
              <Crosshair className="h-3 w-3 shrink-0 text-[var(--violet-text)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-[var(--text-primary)]" title={scope}>
                {scope === "." ? "/" : scope}
              </span>
              <span className="tnum shrink-0 text-micro text-[var(--text-muted)]">{scopedSymbols.length}</span>
              <button
                type="button"
                onClick={onClearScope}
                title="Clear selection — search the whole graph"
                className="shrink-0 cursor-pointer text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="relative mb-md">
            <Search className="w-4 h-4 text-[var(--text-secondary)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={scope ? "Filter these symbols…" : "Search symbols, tags (auth, db, http)…"}
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
                <div className="flex min-w-0 items-center gap-sm">
                  <span className="shrink-0 rounded-xs px-xs py-2xs font-mono text-micro" style={kindChip(s.kind)}>{s.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-meta text-[var(--text-primary)]">{s.name}</span>
                  {s.exported && <span className="shrink-0 text-micro text-[var(--accent-text)]">export</span>}
                </div>
                <div className="truncate font-mono text-micro text-[var(--text-muted)]">{s.file}:{s.line}</div>
                {s.tags.length > 0 && <div className="mt-2xs truncate text-micro text-[var(--violet-text)]">{s.tags.join(" · ")}</div>}
              </button>
            ))}
            {!loading && results.length === 0 && (q || scope) && (
              <p className="text-meta text-[var(--text-muted)] py-md text-center">
                {scope ? "No symbols extracted here." : "No matches."}
              </p>
            )}
            {!q && !scope && (
              <p className="text-meta text-[var(--text-muted)] py-md text-center">
                Click a node in the graph above, or type to search the symbol graph.
              </p>
            )}
          </div>
        </div>

        {/* Selected symbol + relationships */}
        <div className="min-w-0 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
          {selected ? (
            <>
              <div className="mb-md">
                <div className="flex min-w-0 flex-wrap items-center gap-sm">
                  <span className="shrink-0 rounded-xs px-xs py-2xs font-mono text-micro" style={kindChip(selected.kind)}>{selected.kind}</span>
                  <span className="min-w-0 text-h3 font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">{selected.name}</span>
                </div>
                <div className="mt-2xs break-all font-mono text-micro text-[var(--text-muted)]">{selected.file}:{selected.line}</div>
                {selected.doc && (
                  <p className="mt-sm max-h-40 overflow-y-auto whitespace-pre-wrap text-meta italic text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                    {selected.doc}
                  </p>
                )}
                <code className="mt-sm block rounded-md bg-[var(--surface-inset)] p-sm font-mono text-meta text-[var(--accent-text)] [overflow-wrap:anywhere]">{selected.signature}</code>
                <div className="mt-sm flex flex-wrap gap-x-md gap-y-2xs text-micro text-[var(--text-secondary)]">
                  <span className="whitespace-nowrap">callers <b className="text-[var(--text-primary)]">{selected.fanIn}</b></span>
                  <span className="whitespace-nowrap">callees <b className="text-[var(--text-primary)]">{selected.fanOut}</b></span>
                </div>
              </div>
              {/* The relation switch wraps rather than overflowing: four labelled tabs
                  need ~330px, and this panel is draggable down to 320. A `grid` of
                  equal tracks keeps them aligned on both one and two rows, and the
                  label hides under ~200px so the icon alone carries the control. */}
              <div className="mb-sm grid grid-cols-2 gap-2xs rounded-md border border-[var(--line)] bg-[var(--surface-2)] p-2xs text-meta @[26rem]:grid-cols-4">
                {(["callees", "callers", "members", "impact"] as Rel[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRel(r)}
                    title={r}
                    className={`flex min-w-0 items-center justify-center gap-2xs rounded-sm px-xs py-2xs capitalize transition-colors ${rel === r ? "bg-[var(--accent-fill)] text-[var(--accent-on-fill)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
                  >
                    {r === "callees" && <ArrowDownRight className="h-3 w-3 shrink-0" />}
                    {r === "callers" && <ArrowUpRight className="h-3 w-3 shrink-0" />}
                    {r === "members" && <Boxes className="h-3 w-3 shrink-0" />}
                    {r === "impact" && <Radius className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{r}</span>
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
                    <button key={s.id} onClick={() => setSelected(s)} className="w-full min-w-0 px-2xs py-xs text-left hover:bg-[var(--surface-hover)]">
                      <div className="truncate text-meta text-[var(--text-primary)]">{s.name}</div>
                      <div className="truncate font-mono text-micro text-[var(--text-muted)]">{s.file}:{s.line}</div>
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
  const [task, setTask] = useSharedState(key(repoId, "task"), "");
  const [ctx, setCtx] = useSharedState<AIContext | null>(key(repoId, "ctx"), null);
  const [error, setError] = useSharedState<string | null>(key(repoId, "ctxError"), null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function run() {
    if (!task.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setCtx(await intelContext(repoId, task));
    } catch (e) {
      // Without this the rejection was unhandled and the panel simply sat there
      // showing the previous prompt as if nothing had been asked.
      setCtx(null);
      setError(e instanceof Error ? e.message : "Failed to build context");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--violet-500)]/20 bg-gradient-to-br from-[var(--violet-500)]/[0.06] to-transparent p-md">
      <h3 className="mb-2xs flex items-center gap-sm text-h3 text-[var(--text-primary)]"><Sparkles className="h-4 w-4 shrink-0 text-[var(--violet-text)]" /> <span className="min-w-0 [overflow-wrap:anywhere]">Graph-RAG AI Context</span></h3>
      <p className="mb-md max-w-note text-meta text-[var(--text-secondary)]">Describe a task; CodeGraph assembles a token-budgeted, structurally-relevant prompt from the symbol graph.</p>
      <div className="flex flex-col gap-sm @[30rem]:flex-row">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="e.g. optimize authentication and session handling"
          className="flex-1 rounded-md bg-[var(--surface-2)] border border-[var(--line)] px-md py-sm text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--violet-500)]/50"
        />
        <button onClick={() => void run()} disabled={loading || !task.trim()} className="flex shrink-0 items-center justify-center gap-sm rounded-md bg-[var(--accent-fill)] px-lg py-sm text-meta font-semibold text-[var(--accent-on-fill)] hover:bg-[var(--signal-400)] disabled:opacity-40">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Build
        </button>
      </div>
      {error && <p className="mt-md text-meta text-[var(--coral-text)]">{error}</p>}
      {ctx && (
        <div className="mt-md">
          <div className="mb-2xs flex flex-wrap items-center justify-between gap-x-md gap-y-2xs text-meta text-[var(--text-secondary)]">
            <span className="min-w-0 [overflow-wrap:anywhere]">{ctx.slices.length} symbols · ~{ctx.tokenEstimate} tokens{ctx.truncated ? " · budget-capped" : ""}</span>
            <button onClick={() => { navigator.clipboard.writeText(ctx.prompt); setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1500); }} className="flex shrink-0 items-center gap-2xs hover:text-[var(--text-primary)]">
              {copied ? <><Check className="h-3 w-3 text-[var(--accent-text)]" /> copied</> : <><Copy className="h-3 w-3" /> copy prompt</>}
            </button>
          </div>
          <pre className="text-meta text-[var(--text-primary)] bg-[var(--surface-inset)] rounded-md p-md max-h-[300px] overflow-auto whitespace-pre-wrap font-mono">{ctx.prompt}</pre>
        </div>
      )}
    </div>
  );
}

type AuditOp = "cycles" | "deadcode" | "hubs";
type AuditData = { results?: CodeSymbol[]; cycles?: string[][] };

function AuditRow({ repoId }: { repoId: string }) {
  const [tab, setTab] = useSharedState<AuditOp | null>(key(repoId, "auditTab"), null);
  const [data, setData] = useSharedState<AuditData | null>(key(repoId, "auditData"), null);
  const [error, setError] = useSharedState<string | null>(key(repoId, "auditError"), null);
  const [loading, setLoading] = useState(false);

  async function run(op: AuditOp) {
    setTab(op);
    // The previous tab's rows must go now, not when the new ones arrive: a slow
    // or failing audit otherwise renders last tab's findings under this tab's label.
    setData(null);
    setError(null);
    setLoading(true);
    try {
      setData(await intelAudit(repoId, op));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
      <div className="flex flex-wrap gap-sm mb-md">
        <AuditBtn active={tab === "cycles"} onClick={() => void run("cycles")} icon={<AlertTriangle className="w-3.5 h-3.5" />} label="Circular deps" />
        <AuditBtn active={tab === "deadcode"} onClick={() => void run("deadcode")} icon={<Skull className="w-3.5 h-3.5" />} label="Dead code" />
        <AuditBtn active={tab === "hubs"} onClick={() => void run("hubs")} icon={<Radius className="w-3.5 h-3.5" />} label="Hub symbols" />
      </div>
      {loading ? (
        <div className="flex items-center gap-sm text-[var(--text-secondary)] text-meta py-md"><Loader2 className="w-3 h-3 animate-spin" /> analyzing…</div>
      ) : error ? (
        <p className="text-meta text-[var(--coral-text)]">{error}</p>
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
