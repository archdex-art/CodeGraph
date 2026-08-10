"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, FlaskConical, Loader2, Radius, Search } from "lucide-react";
import { intelBlast, intelSearch, intelUntestedHubs } from "@/lib/api";
import type { BlastCaller, BlastReport } from "@/lib/codeintel/query";
import type { CodeSymbol } from "@/lib/types";
import { Empty, SectionHead, useRepo } from "../repo-context";

const NO_SYMBOLS: CodeSymbol[] = [];

/** Callers of one file, so the answer reads as "these files break", not "these 40 functions". */
type FileGroup = {
  file: string;
  callers: BlastCaller[];
  /** Nearest hop in the group — the sort key, because closest breaks first. */
  nearest: number;
  tested: number;
};

/**
 * Group by file, nearest-first.
 *
 * A blast radius arrives as a flat list of symbols, and a flat list of forty function
 * names is a wall. What a reader is deciding is which FILES they now have to open, and
 * how far away each one is, so the file is the row and the hop distance of its closest
 * caller is the order.
 */
function groupByFile(callers: readonly BlastCaller[]): FileGroup[] {
  const byFile = new Map<string, BlastCaller[]>();
  for (const c of callers) {
    const bucket = byFile.get(c.file);
    if (bucket) bucket.push(c);
    else byFile.set(c.file, [c]);
  }
  return [...byFile.entries()]
    .map(([file, group]) => ({
      file,
      callers: [...group].sort((a, b) => a.hops - b.hops || a.line - b.line),
      nearest: Math.min(...group.map((c) => c.hops)),
      tested: group.filter((c) => c.tested).length,
    }))
    .sort((a, b) => a.nearest - b.nearest || b.callers.length - a.callers.length || a.file.localeCompare(b.file));
}

/** The result of one blast-radius request, tagged with the symbol that asked for it. */
interface Loaded {
  readonly for: string;
  readonly report: BlastReport | null;
  readonly error: string | null;
}

export default function ImpactPage() {
  const repo = useRepo();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedId = params.get("symbol") ?? "";

  /**
   * The selection lives in `?symbol=`, not in state.
   *
   * A blast radius is the thing you paste into a pull request or a Slack thread —
   * "here is what this touches" is worth nothing if the recipient has to re-run the
   * search to see it. `replace` rather than `push` for the same reason `useGraphUrl`
   * does: picking through a candidate list is not twenty history entries.
   */
  const select = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("symbol", id);
      else next.delete("symbol");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  const [q, setQ] = useState("");
  /** Symbols together with the exact query they answer. */
  const [found, setFound] = useState<{ readonly for: string; readonly symbols: CodeSymbol[] } | null>(null);

  /** A blast radius together with the symbol id it was computed for. */
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  /**
   * DERIVED, not stored. An empty query has no results and an unselected symbol has no blast
   * radius — those are facts about the current inputs, so reading them from the inputs cannot
   * go stale. The version that cleared them with `setState` inside the effect rendered the
   * PREVIOUS symbol's radius for one frame after a deselect, and cost a cascading render on
   * every keystroke that emptied the box (`react-hooks/set-state-in-effect`).
   */
  const query = q.trim();
  const results = query && found?.for === query ? found.symbols : NO_SYMBOLS;
  // In flight whenever the answer on hand is not the answer to what is typed now. A stored
  // boolean said "done" while the previous query's rows were still on screen.
  const searching = query !== "" && found?.for !== query;
  const current = selectedId && loaded?.for === selectedId ? loaded : null;
  const blast = current?.report ?? null;
  const blastError = current?.error ?? null;
  const blastLoading = selectedId !== null && current === null;

  const [hubs, setHubs] = useState<CodeSymbol[]>(NO_SYMBOLS);
  const [hubsLoading, setHubsLoading] = useState(true);

  // Debounced, mirroring CodeIntelPanel: the same 250ms and the same cancel-on-clear,
  // because a search box that behaves differently on two pages is two search boxes.
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      // Failure records the query too, so the box settles on "no matches" instead of
      // spinning forever against a request that will never arrive.
      const symbols = await intelSearch(repo.id, query).catch(() => NO_SYMBOLS);
      if (!cancelled) setFound({ for: query, symbols });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, repo.id]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // One state write per outcome, and the write CARRIES the symbol it describes. Loading is
    // then "the record on hand is not for this symbol", which cannot get out of step with the
    // selection the way a separate boolean did.
    void intelBlast(repo.id, selectedId)
      .then((r): Loaded => ({
        for: selectedId,
        report: r,
        // A link can outlive a re-index, and an empty panel would look like "nothing calls
        // this" rather than "this symbol is gone".
        error: r.symbol ? null : `No symbol ${selectedId} in the current index.`,
      }))
      .catch(
        (e: unknown): Loaded => ({
          for: selectedId,
          report: null,
          error: e instanceof Error ? e.message : "Could not compute the blast radius.",
        }),
      )
      .then((next) => {
        if (!cancelled) setLoaded(next);
      });
    return () => {
      cancelled = true;
    };
  }, [repo.id, selectedId]);

  useEffect(() => {
    let cancelled = false;
    intelUntestedHubs(repo.id)
      .then((r) => {
        if (!cancelled) setHubs(r);
      })
      .catch(() => {
        if (!cancelled) setHubs(NO_SYMBOLS);
      })
      .finally(() => {
        if (!cancelled) setHubsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo.id]);

  const groups = useMemo(() => groupByFile(blast?.callers ?? []), [blast]);

  if (!repo.symbolGraph || repo.symbolGraph.symbols.length === 0) {
    return (
      <>
        <SectionHead eyebrow="Intelligence" title="Impact" />
        <Empty msg="No symbols extracted (unsupported languages, or re-index needed)." />
      </>
    );
  }

  return (
    <>
      <SectionHead
        eyebrow="Intelligence"
        title="Impact"
        blurb="What breaks if you change a symbol — every transitive caller, how far away it is, and whether a test file is anywhere on the path. Below it, the hubs no test reaches at all."
      />

      <section className="space-y-md">
        <div className="split-phi-rev">
          {/* min-w-0: an unbroken path in the results would otherwise widen the track. */}
          <div className="min-w-0 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
            <div className="relative mb-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-secondary)]" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search a symbol or a file to change…"
                className="w-full rounded-md border border-[var(--line)] bg-[var(--surface-2)] py-sm pl-xl pr-md text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--violet-500)]/50 focus:outline-none"
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--text-secondary)]" />
              )}
            </div>
            <div className="max-h-[360px] divide-y divide-[var(--line-soft)] overflow-auto">
              {results.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => select(s.id)}
                  className={`w-full cursor-pointer px-2xs py-sm text-left transition-colors hover:bg-[var(--surface-hover)] ${
                    selectedId === s.id ? "bg-[var(--surface-active)]" : ""
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-sm">
                    <span className="min-w-0 flex-1 truncate text-meta text-[var(--text-primary)]">{s.name}</span>
                    <span className="tnum shrink-0 text-micro text-[var(--text-muted)]">{s.fanIn} in</span>
                  </div>
                  <div className="truncate font-mono text-micro text-[var(--text-muted)]">
                    {s.file}:{s.line}
                  </div>
                </button>
              ))}
              {!searching && query && results.length === 0 && (
                <p className="py-md text-center text-meta text-[var(--text-muted)]">No matches.</p>
              )}
              {!q.trim() && (
                <p className="py-md text-center text-meta text-[var(--text-muted)]">
                  Name the thing you are about to change.
                </p>
              )}
            </div>
          </div>

          <div className="min-w-0 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)] p-md">
            {!selectedId && (
              <p className="py-xl text-center text-meta text-[var(--text-muted)]">
                Pick a symbol. Its transitive callers appear here, grouped by file.
              </p>
            )}
            {selectedId && blastLoading && !blast && (
              <p className="flex items-center justify-center gap-sm py-xl text-meta text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Walking the call graph…
              </p>
            )}
            {blastError && (
              <p className="flex items-center gap-sm rounded-md border border-[var(--amber-400)]/35 px-sm py-xs text-meta text-[var(--amber-text)]">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {blastError}
              </p>
            )}
            {blast?.symbol && (
              <>
                <div className="flex min-w-0 items-baseline gap-sm">
                  <Radius className="h-4 w-4 shrink-0 self-center text-[var(--violet-text)]" />
                  <h3 className="min-w-0 truncate text-lede text-[var(--text-primary)]">{blast.symbol.name}</h3>
                  <span className="shrink-0 text-micro text-[var(--text-muted)]">{blast.symbol.kind}</span>
                </div>
                <p className="mt-2xs truncate font-mono text-micro text-[var(--text-muted)]">
                  {blast.symbol.file}:{blast.symbol.line}
                </p>

                <div className="mt-md flex flex-wrap items-center gap-x-md gap-y-2xs text-meta text-[var(--text-secondary)]">
                  <span className="whitespace-nowrap">
                    <b className="tnum font-semibold text-[var(--text-primary)]">{blast.callers.length}</b> callers
                  </span>
                  <span className="whitespace-nowrap">
                    <b className="tnum font-semibold text-[var(--text-primary)]">{groups.length}</b> files
                  </span>
                  <span
                    className="whitespace-nowrap"
                    style={{ color: blast.testedCount > 0 ? "var(--accent-text)" : "var(--coral-text)" }}
                  >
                    <b className="tnum font-semibold">{blast.testedCount}</b> in test files
                  </span>
                </div>

                {/* The hop histogram: one hop is "callers", three hops is "the part you
                    were not going to check". Counting them is the cheap version of that. */}
                <div className="mt-sm flex flex-wrap gap-xs">
                  {blast.perHop.map((n, i) => (
                    <span
                      key={i}
                      className="tnum rounded-xs border border-[var(--line)] bg-[var(--surface-2)] px-xs py-2xs text-micro text-[var(--text-secondary)]"
                    >
                      hop {i + 1}: {n}
                    </span>
                  ))}
                </div>

                {blast.testedCount === 0 && blast.callers.length > 0 && (
                  <p className="mt-sm flex items-start gap-sm rounded-md border border-[var(--coral-500)]/35 px-sm py-xs text-meta text-[var(--coral-text)]">
                    <AlertTriangle className="mt-hair h-4 w-4 shrink-0" />
                    Nothing in this radius is a test file — every one of these callers changes
                    unobserved.
                  </p>
                )}

                {blast.callers.length === 0 && (
                  <p className="mt-md text-meta text-[var(--text-muted)]">
                    No resolved callers within {blast.depth} hops. Either it is an entry point, or
                    the call is made in a way the extractor cannot resolve.
                  </p>
                )}

                <div className="mt-md max-h-[480px] space-y-sm overflow-auto">
                  {groups.map((g) => (
                    <div key={g.file} className="rounded-md border border-[var(--line-soft)] bg-[var(--surface-2)] p-sm">
                      <div className="flex min-w-0 items-center gap-sm">
                        <span className="min-w-0 flex-1 truncate font-mono text-micro text-[var(--text-primary)]" title={g.file}>
                          {g.file}
                        </span>
                        <span className="tnum shrink-0 text-micro text-[var(--text-muted)]">
                          {g.callers.length} · hop {g.nearest}
                        </span>
                        {g.tested > 0 ? (
                          <FlaskConical className="h-3 w-3 shrink-0 text-[var(--accent-text)]" aria-label="test file" />
                        ) : null}
                      </div>
                      <ul className="mt-xs space-y-2xs">
                        {g.callers.map((c) => (
                          <li key={c.id} className="flex min-w-0 items-center gap-sm">
                            <span className="tnum shrink-0 rounded-xs border border-[var(--line)] px-xs text-micro text-[var(--text-muted)]">
                              {c.hops}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-meta text-[var(--text-secondary)]">
                              {c.name}
                              <span className="tnum ml-xs text-micro text-[var(--text-muted)]">:{c.line}</span>
                            </span>
                            <span
                              className="shrink-0 text-micro"
                              style={{ color: c.tested ? "var(--accent-text)" : "var(--text-muted)" }}
                            >
                              {c.tested ? "covered" : "not covered"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="mt-2xl">
        <h3 className="font-display text-h3 tracking-tight text-[var(--text-primary)]">Untested hubs</h3>
        <p className="mt-sm max-w-note text-meta text-[var(--text-muted)]">
          Symbols with the most callers that no test file reaches, most-depended-upon first.
          This is the same set the agent swarm raises as &ldquo;untested core logic&rdquo; — one
          definition, so the two cannot disagree. Pick one to see what it would take down.
        </p>
        <div className="mt-md rounded-lg border border-[var(--line-soft)] bg-[var(--surface-1)]">
          {hubsLoading && (
            <p className="flex items-center justify-center gap-sm py-xl text-meta text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Ranking hubs…
            </p>
          )}
          {!hubsLoading && hubs.length === 0 && (
            <p className="py-xl text-center text-meta text-[var(--text-muted)]">
              Every hub in this graph has a test caller. That is the good outcome.
            </p>
          )}
          <ul className="divide-y divide-[var(--line-soft)]">
            {hubs.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => select(h.id)}
                  className={`flex w-full cursor-pointer items-center gap-md px-md py-sm text-left transition-colors hover:bg-[var(--surface-hover)] ${
                    selectedId === h.id ? "bg-[var(--surface-active)]" : ""
                  }`}
                >
                  <span className="tnum w-rail-collapsed shrink-0 text-meta font-semibold text-[var(--coral-text)]">
                    {h.fanIn}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-meta text-[var(--text-primary)]">{h.name}</span>
                    <span className="block truncate font-mono text-micro text-[var(--text-muted)]">
                      {h.file}:{h.line}
                    </span>
                  </span>
                  <span className="shrink-0 text-micro text-[var(--text-muted)]">{h.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
