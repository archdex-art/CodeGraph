"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, ArrowUpRight } from "lucide-react";
import type { Dimension } from "@/lib/types";
import { DIMENSION_META, PILLAR_META, pillarsFrom } from "@/lib/types";
import { CountUp, Reveal, Stagger, StaggerItem } from "@/components/motion/primitives";
import { band, useRepo } from "./repo-context";
import { SECTIONS, sectionHref } from "./sections";

/**
 * Severity carries a WORD as well as a colour.
 *
 * This table is the page's action queue, and a queue whose priority is encoded only
 * in hue is unreadable to anyone who cannot separate coral from amber — roughly one
 * in twelve men. The colour is the fast scan; the label is the fact.
 */
const SEVERITY: Record<number, { label: string; tone: string; chip: string }> = {
  5: { label: "Critical", tone: "text-[var(--coral-400)]", chip: "border-[var(--coral-500)]/40 bg-[var(--coral-500)]/10" },
  4: { label: "High", tone: "text-[var(--coral-400)]", chip: "border-[var(--coral-500)]/30 bg-[var(--coral-500)]/[0.06]" },
  3: { label: "Medium", tone: "text-[var(--amber-400)]", chip: "border-[var(--amber-400)]/30 bg-[var(--amber-400)]/[0.06]" },
  2: { label: "Low", tone: "text-[var(--text-muted)]", chip: "border-[var(--line)] bg-[var(--ink-700)]" },
  1: { label: "Info", tone: "text-[var(--text-muted)]", chip: "border-[var(--line)] bg-[var(--ink-700)]" },
};

/** Word for a pillar reading, so a bar is never the only carrier. */
function rating(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Good";
  if (score >= 60) return "Fair";
  return "Poor";
}

/**
 * The analysis tiers (HLD 8.3). A file is not simply "scanned or not" — it is read
 * at the deepest level its language and size allowed, and the tier decides which
 * detections are even possible.
 *
 * Ordered deepest-first so the bar reads left-to-right as confidence descending.
 */
const TIER_META: Record<string, { label: string; color: string; note: string }> = {
  full: {
    label: "Typed",
    color: "var(--signal-500)",
    note: "Typed lines are read with a real type checker, so call resolution and interprocedural analysis are available on them. Lexical lines are pattern-matched only, and findings on them are marked low-confidence.",
  },
  ast: {
    label: "AST",
    color: "var(--violet-500)",
    note: "AST lines are parsed but untyped: structural rules and intraprocedural dataflow apply, precise call resolution does not.",
  },
  lexical: {
    label: "Lexical",
    color: "var(--amber-400)",
    note: "Lexical lines are pattern-matched without a parse, so only syntactic rules apply and their findings are marked low-confidence.",
  },
  skipped: {
    label: "Skipped",
    color: "var(--text-faint)",
    note: "Skipped lines were too large, unreadable, or past the budget, and contribute nothing to the score.",
  },
};
const TIER_ORDER = ["full", "ast", "lexical", "skipped"] as const;

export default function RepoOverview() {
  const repo = useRepo();

  const pillars = pillarsFrom(repo.dimensions ?? []);
  const surfaced = pillars.find((p) => PILLAR_META[p.pillar].surfaced);
  /**
   * The headline is DERIVED from the stored dimensions, not read from the stored
   * `score`. That column holds whatever the model produced when the repo was indexed —
   * for anything indexed before the pillar split, a blend that included
   * maintainability. Reading it would put an old-model headline directly above
   * new-model pillar numbers computed from the same row: inconsistent AND
   * unexplainable. Deriving makes every existing repo correct with no re-index.
   */
  const overall = surfaced?.score ?? repo.score ?? 0;
  const reading = band(overall);
  const other = pillars.filter((p) => !PILLAR_META[p.pillar].surfaced);
  const measured = other.filter((p) => p.score !== null);
  const unmeasured = other.filter((p) => p.score === null);

  const ranked = [...repo.issues].slice(0, 12);

  /**
   * Percentages are computed over the tiers PRESENT, not over `locAnalysed`, so the
   * segments always total 100% of the bar. Tiers the run never produced are absent
   * rather than drawn at zero width — `ast` is defined in the model but not currently
   * emitted, and a zero-width segment with a legend entry claims a capability the
   * index did not exercise.
   */
  const tierEntries = TIER_ORDER.map((key) => ({ key, loc: repo.coverage?.tierLoc?.[key] ?? 0 })).filter(
    (t) => t.loc > 0
  );
  const tierTotal = tierEntries.reduce((sum, t) => sum + t.loc, 0) || 1;
  const tiers = tierEntries.map((t) => ({ ...t, pct: (t.loc / tierTotal) * 100 }));
  const fullPct = Math.round(((repo.coverage?.tierLoc?.full ?? 0) / tierTotal) * 100);

  return (
    <>
      {/* ---------------------------------------------------------- CODE HEALTH */}
      <Reveal>
        <section>
          <p className="eyebrow mb-5">Code health</p>
          <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <div>
              <div className="flex flex-wrap items-center gap-3.5">
                <span className="tnum text-[56px] leading-none" style={{ color: reading.color }}>
                  <CountUp to={overall} duration={1.1} />
                </span>
                <span className="text-[15px] text-[var(--text-muted)]">out of 100</span>
                <span
                  className="rounded-full border px-2.5 py-1 text-[12px]"
                  style={{
                    color: reading.color,
                    borderColor: `color-mix(in oklab, ${reading.color} 34%, transparent)`,
                    background: `color-mix(in oklab, ${reading.color} 9%, transparent)`,
                  }}
                >
                  {reading.label}
                </span>
              </div>

              {/* Prose, because a reader should not have to assemble the meaning from
                  a grid of numerals. Every clause below is read off the index. */}
              <p className="mt-5 max-w-2xl text-[14.5px] leading-relaxed text-[var(--text-secondary)]">
                <span className="text-[var(--text-primary)]">{repo.name}</span> scores{" "}
                <span className="tnum text-[var(--text-primary)]">{overall}</span> out of 100 on defect
                risk, which CodeGraph reads as{" "}
                <span style={{ color: reading.color }}>{reading.label.toLowerCase()}</span>.
                {measured.map((p) => (
                  <span key={p.pillar}>
                    {" "}
                    {PILLAR_META[p.pillar].label} scores{" "}
                    <span className="tnum text-[var(--text-primary)]">{p.score}</span>.
                  </span>
                ))}
                {unmeasured.length > 0 && (
                  <>
                    {" "}
                    {unmeasured.map((p) => PILLAR_META[p.pillar].label).join(" and ")} was not measured
                    for this index — reported as unknown rather than as a pass.
                  </>
                )}{" "}
                The pillars are scored separately and never averaged into one number, so a tidy
                codebase cannot flatter a fragile one.{" "}
                {repo.issues.length > 0 ? (
                  <>
                    <span className="tnum text-[var(--text-primary)]">{repo.issues.length}</span>{" "}
                    {repo.issues.length === 1 ? "finding" : "findings"} were emitted, ranked below by
                    severity weighted with blast radius through the graph.
                  </>
                ) : (
                  <>No findings were emitted.</>
                )}{" "}
                {/* ADR-008: the score states the coverage it was computed over, INSIDE the
                    sentence that makes the claim. It was briefly moved to the header meta
                    line during a layout rebuild, where it read as index trivia rather than
                    as a qualifier on the number — a doc guard caught that, correctly. */}
                {repo.coverage ? (
                  <span className="text-[var(--text-muted)]">
                    Scored over{" "}
                    <span className="tnum">
                      {repo.coverage.filesSeen === 0
                        ? "—"
                        : `${Math.round((repo.coverage.filesAnalysed / repo.coverage.filesSeen) * 100)}%`}
                    </span>{" "}
                    of files (<span className="tnum">{repo.coverage.filesAnalysed}</span> of{" "}
                    <span className="tnum">{repo.coverage.filesSeen}</span>
                    {repo.coverage.skippedTooLarge > 0 && (
                      <>
                        , <span className="tnum">{repo.coverage.skippedTooLarge}</span> over the size cap
                      </>
                    )}
                    {repo.coverage.skippedNoLanguage > 0 && (
                      <>
                        , <span className="tnum">{repo.coverage.skippedNoLanguage}</span> unsupported
                      </>
                    )}
                    ){repo.coverage.capHit && <span className="text-[var(--amber-400)]"> — the scan hit the file cap</span>}.
                  </span>
                ) : (
                  <span className="text-[var(--text-faint)]">
                    Coverage was not recorded for this index, so what it was computed over is
                    unknown — reported as unknown rather than as complete.
                  </span>
                )}
              </p>

              <Link
                href={sectionHref(repo.id, "agents")}
                className="group mt-5 inline-flex cursor-pointer items-center gap-1.5 text-[13.5px] text-[var(--signal-500)] transition-opacity duration-200 hover:opacity-80"
              >
                Run the swarm on these findings
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>

            {/* The three pillars as bars. Each states its number and a word, so the
                bar length is reinforcement rather than the only signal. */}
            <Stagger className="flex flex-col gap-5 self-center" step={0.08}>
              {pillars.map((p) => {
                const meta = PILLAR_META[p.pillar];
                const score = p.score;
                const tone = score === null ? "var(--text-faint)" : band(score).color;
                return (
                  <StaggerItem key={p.pillar}>
                    <div className="mb-2 flex items-baseline justify-between gap-4">
                      <span className="text-[13.5px] text-[var(--text-primary)]" title={meta.question}>
                        {meta.label}
                      </span>
                      <span className="text-[12.5px] text-[var(--text-muted)]">
                        {score === null ? (
                          "not measured"
                        ) : (
                          <>
                            <span className="tnum text-[var(--text-secondary)]">{score}</span>/100 ·{" "}
                            {rating(score)}
                          </>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ink-700)]">
                      <div
                        className="h-full rounded-full transition-[width] duration-700"
                        style={{ width: `${score ?? 0}%`, background: tone }}
                      />
                    </div>
                  </StaggerItem>
                );
              })}
            </Stagger>
          </div>
        </section>
      </Reveal>

      {/* ---------------------------------------------------------- TIER LADDER */}
      {repo.coverage?.tierLoc && Object.keys(repo.coverage.tierLoc).length > 0 && (
        <Reveal>
          <section className="mt-9">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <p className="eyebrow">Analysis depth</p>
              <p className="text-[12.5px] text-[var(--text-muted)]">
                <span className="tnum text-[var(--text-secondary)]">{TIER_META.full.label}</span> covers{" "}
                <span className="tnum text-[var(--text-secondary)]">{fullPct}%</span> of analysed lines
              </p>
            </div>

            {/* One bar, segmented and labelled — the depth a line was read at is not a
                yes/no, and a single "coverage %" hides that half a codebase can be
                counted while only being pattern-matched. HLD 8.3 records the ladder;
                until now nothing rendered it. */}
            <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
              {tiers.map((t) => (
                <div
                  key={t.key}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${t.pct}%`, background: TIER_META[t.key].color }}
                  title={`${TIER_META[t.key].label}: ${t.loc.toLocaleString()} LOC (${t.pct.toFixed(1)}%)`}
                />
              ))}
            </div>

            <dl className="mt-3.5 flex flex-wrap gap-x-7 gap-y-2.5">
              {tiers.map((t) => (
                <div key={t.key} className="flex items-baseline gap-2">
                  <span
                    className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-sm"
                    style={{ background: TIER_META[t.key].color }}
                    aria-hidden="true"
                  />
                  <dt className="text-[12.5px] text-[var(--text-secondary)]">{TIER_META[t.key].label}</dt>
                  <dd className="tnum text-[12.5px] text-[var(--text-muted)]">
                    {t.pct.toFixed(0)}% · {t.loc.toLocaleString()} LOC
                  </dd>
                </div>
              ))}
            </dl>

            <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-[var(--text-muted)]">
              {TIER_META[tiers[0].key].note}
            </p>
          </section>
        </Reveal>
      )}

      {/* ----------------------------------------------------------- STAT STRIP */}
      <Reveal>
        <dl className="mt-10 grid grid-cols-2 border-y border-[var(--line)] sm:grid-cols-3 lg:grid-cols-5">
          {[
            { k: "Files", v: repo.graphStats?.files ?? 0 },
            { k: "Symbols", v: repo.symbolGraph?.stats.symbols ?? repo.graphStats?.nodes ?? 0 },
            { k: "Graph edges", v: repo.graphStats?.edges ?? 0 },
            { k: "Dependencies", v: repo.graphStats?.dependencies ?? 0 },
            { k: "Findings", v: repo.issues.length },
          ].map((s, i) => (
            <div
              key={s.k}
              className={`px-5 py-6 ${i > 0 ? "sm:border-l sm:border-[var(--line)]" : ""} ${
                i % 2 === 1 ? "border-l border-[var(--line)] sm:border-l" : ""
              }`}
            >
              <dt className="eyebrow">{s.k}</dt>
              <dd className="tnum mt-2 text-[26px] leading-none text-[var(--text-primary)]">
                {s.v.toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>

      {repo.symbolGraph?.truncated && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-[var(--amber-400)]/25 bg-[var(--amber-400)]/[0.05] px-4 py-3.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--amber-400)]" />
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            Symbol graph truncated — code intelligence covers{" "}
            <span className="tnum">{repo.symbolGraph.stats.symbols.toLocaleString()}</span> symbols
            indexed, not the whole codebase.
          </p>
        </div>
      )}

      {/* -------------------------------------------------- WHERE RISK CONCENTRATES */}
      <Reveal>
        <section className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-display text-[1.5rem] tracking-tight text-[var(--text-primary)]">
              Where the risk concentrates
            </h2>
            {repo.issues.length > ranked.length && (
              <Link
                href={sectionHref(repo.id, "code-intel")}
                className="cursor-pointer text-[13px] text-[var(--signal-500)] transition-opacity duration-200 hover:opacity-80"
              >
                All <span className="tnum">{repo.issues.length}</span> findings
              </Link>
            )}
          </div>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-muted)]">
            Ranked by severity weighted with blast radius — how many symbols reach this one through
            the graph — rather than by severity alone.
          </p>

          {repo.issues.length === 0 ? (
            <p className="mt-6 flex items-center gap-2.5 text-sm text-[var(--signal-500)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--signal-500)]" aria-hidden="true" />
              No findings detected in this index.
            </p>
          ) : (
            <div className="mt-6 overflow-hidden">
              <div className="hidden grid-cols-[minmax(0,1fr)_7rem_5rem_5rem] gap-4 border-b border-[var(--line)] pb-2.5 sm:grid">
                <span className="eyebrow">Finding</span>
                <span className="eyebrow">Severity</span>
                <span className="eyebrow text-right">Blast</span>
                <span className="eyebrow text-right">Churn</span>
              </div>
              <Stagger className="divide-y divide-[var(--line-soft)]" step={0.03}>
                {ranked.map((iss) => {
                  const sev = SEVERITY[iss.severity] ?? SEVERITY[1];
                  return (
                    <StaggerItem key={iss.id}>
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_7rem_5rem_5rem]">
                        <div className="min-w-0">
                          <p className="truncate text-[14px] text-[var(--text-primary)]">{iss.title}</p>
                          <p className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--text-muted)]">
                            {iss.file}
                            {iss.line > 1 ? `:${iss.line}` : ""}
                          </p>
                        </div>
                        <span
                          className={`justify-self-start rounded-md border px-2 py-1 text-[10px] font-medium tracking-[0.08em] uppercase ${sev.chip} ${sev.tone}`}
                        >
                          <span className="tnum">S{iss.severity}</span> {sev.label}
                        </span>
                        <span className="tnum hidden text-right text-[13px] text-[var(--text-secondary)] sm:block">
                          ×{iss.blastRadius}
                        </span>
                        <span className="tnum hidden text-right text-[13px] text-[var(--text-muted)] sm:block">
                          {iss.churn ?? "—"}
                        </span>
                      </div>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            </div>
          )}
        </section>
      </Reveal>

      {/* --------------------------------------------------------- SCORE DETAIL */}
      <Reveal>
        <section className="mt-12">
          <h2 className="font-display text-[1.5rem] tracking-tight text-[var(--text-primary)]">
            How the score was reached
          </h2>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-muted)]">
            Five dimensions, each weighted, each traceable to the findings that moved it.
          </p>
          <Stagger className="mt-6 space-y-4">
            {repo.dimensions.map((d) => {
              const meta = DIMENSION_META[d.dimension as Dimension];
              const dim = band(d.score);
              return (
                <StaggerItem key={d.dimension}>
                  <div className="mb-2 flex items-baseline justify-between gap-4">
                    <span className="text-[13.5px] text-[var(--text-primary)]">
                      {meta.label}{" "}
                      <span className="text-[12px] text-[var(--text-muted)]">
                        · <span className="tnum">{d.issueCount}</span> issues · weight{" "}
                        <span className="tnum">{Math.round(meta.weight * 100)}%</span>
                      </span>
                    </span>
                    <span className="tnum text-[13.5px]" style={{ color: dim.color }}>
                      {d.score}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ink-700)]">
                    <div className="h-full rounded-full" style={{ width: `${d.score}%`, background: dim.color }} />
                  </div>
                </StaggerItem>
              );
            })}
          </Stagger>
        </section>
      </Reveal>

      {/* ------------------------------------------------------- SECTION INDEX */}
      <Reveal>
        <section className="mt-12">
          <h2 className="font-display text-[1.5rem] tracking-tight text-[var(--text-primary)]">
            Read more about {repo.name}
          </h2>
          <Stagger className="mt-5 grid gap-2.5 sm:grid-cols-2" step={0.05}>
            {SECTIONS.filter((s) => s.slug).map((s) => (
              <StaggerItem key={s.slug}>
                <Link
                  href={sectionHref(repo.id, s.slug)}
                  className="panel group flex h-full cursor-pointer items-start gap-3.5 p-4 transition-colors duration-200 hover:border-line-strong"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--ink-800)]">
                    <s.icon className="h-4 w-4 text-[var(--text-muted)] transition-colors duration-200 group-hover:text-[var(--signal-500)]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[14px] text-[var(--text-primary)]">
                      {s.label}
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)] transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--signal-500)]" />
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                      {s.blurb}
                    </span>
                  </span>
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      </Reveal>
    </>
  );
}
