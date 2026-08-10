"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, ArrowUpRight, ChevronRight, Crosshair, Layers, SquareArrowOutUpRight, Target, TrendingDown } from "lucide-react";
import { tallyByRule } from "@codegraph/analysis-model";
import type { Dimension } from "@/lib/types";
import { DIMENSION_META, PILLAR_META, pillarsFrom } from "@/lib/types";
import type { FindingGroupKey, TierFilter } from "@/lib/findings";
import { GROUP_META, editorHref, findingLocation, groupByTier, parseTierFilter, ruleBreakdown } from "@/lib/findings";
import { coverageNote } from "@/lib/coverage-note";
import { plural } from "@/lib/plural";
import { CountUp, Reveal, Stagger, StaggerItem } from "@/components/motion/primitives";
import { FindingEvidence } from "@/components/FindingEvidence";
import { ScoreDial } from "@/components/ScoreDial";
import { TierFilterBar } from "@/components/TierFilterBar";
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
  5: { label: "Critical", tone: "text-[var(--coral-text)]", chip: "border-[var(--coral-500)]/40 bg-[var(--coral-500)]/10" },
  4: { label: "High", tone: "text-[var(--coral-text)]", chip: "border-[var(--coral-500)]/30 bg-[var(--coral-500)]/[0.08]" },
  3: { label: "Medium", tone: "text-[var(--amber-text)]", chip: "border-[var(--amber-400)]/30 bg-[var(--amber-400)]/[0.08]" },
  2: { label: "Low", tone: "text-[var(--text-muted)]", chip: "border-[var(--line)] bg-[var(--surface-3)]" },
  1: { label: "Info", tone: "text-[var(--text-muted)]", chip: "border-[var(--line)] bg-[var(--surface-3)]" },
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

/**
 * A tier's colour, defined once so the breakdown's bars, its tier counts and the group
 * headers below it cannot drift into disagreeing about what "medium" looks like.
 */
const TIER_TONE: Record<FindingGroupKey, string> = {
  high: "var(--coral-text)",
  medium: "var(--amber-text)",
  low: "var(--text-muted)",
  accepted: "var(--text-faint)",
};
const TIER_KEYS: readonly FindingGroupKey[] = ["high", "medium", "low", "accepted"];

/**
 * Rows drawn per open group. The group header always states the true count, so this
 * trims the page without trimming the fact — 71 high-confidence rows inline would push
 * every other section off the bottom of the overview.
 */
const GROUP_CAP = 12;

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

  /**
   * The filter lives in the query string, not in `useState`: "here are the 11 medium
   * findings" is a thing one person sends another, and a filter held in component state
   * makes that link show them the default view instead.
   *
   * `replace`, not `push` — flipping chips is browsing one list, not visiting six pages.
   */
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const filter = parseTierFilter(search.get("tier"));
  const setFilter = (next: TierFilter) => {
    const params = new URLSearchParams(search);
    // `default` is the absence of a choice, so it is the absence of a param.
    if (next === "default") params.delete("tier");
    else params.set("tier", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const tiered = groupByTier(repo.issues, filter);
  const breakdown = ruleBreakdown(repo.issues);
  const topRule = breakdown.rows[0];

  // Null means the run recorded no coverage at all, which the sentence below renders as
  // UNKNOWN — never as complete.
  const coverage = repo.coverage ? coverageNote(repo.coverage) : null;

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

  // Already ranked by the scorer (severity x blast radius), so the first row IS the
  // highest-impact finding — no re-sorting here that could disagree with the table.
  const top = repo.issues[0] ?? null;

  // No depth tile means the finding tile is alone on the bento's second row.
  const wide = tiers.length === 0;

  return (
    <>
      {/* --------------------------------------------------------------- BENTO
          Four tiles at three different weights. The size of a tile is the claim it
          makes: the reading is the largest thing on the page, the pillars and the
          depth it was read at qualify it, and the single highest-impact finding is
          the one thing you can act on without scrolling. Uniform cards would say
          all four matter equally, which is not true. */}
      <div className="grid gap-md lg:grid-cols-3">
        {/* ---- Reading -------------------------------------------------- */}
        <Reveal className="lg:col-span-2">
          <section className="panel relative h-full overflow-hidden p-lg sm:p-xl">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full"
              style={{ background: `radial-gradient(circle, color-mix(in oklab, ${reading.color} 10%, transparent), transparent 70%)` }}
            />
            <div className="relative flex flex-col gap-lg sm:flex-row sm:items-center sm:gap-xl">
              <ScoreDial
                value={overall}
                color={reading.color}
                textColor={reading.textColor}
                label="Defect risk"
                sublabel={reading.label}
              />
              <div className="min-w-0">
                <p className="eyebrow mb-md">Code health</p>
                <p className="max-w-note text-meta text-[var(--text-secondary)]">
                  <span className="text-[var(--text-primary)]">{repo.name}</span> scores{" "}
                  <span className="tnum text-[var(--text-primary)]">{overall}</span> out of 100 on
                  defect risk, which CodeGraph reads as{" "}
                  <span style={{ color: reading.textColor }}>{reading.label.toLowerCase()}</span>.{" "}
                  {repo.issues.length > 0 ? (
                    <>
                      <span className="tnum text-[var(--text-primary)]">{repo.issues.length}</span>{" "}
                      {repo.issues.length === 1 ? "finding was" : "findings were"} emitted, ranked by
                      severity weighted with blast radius through the graph.
                    </>
                  ) : (
                    <>No findings were emitted.</>
                  )}{" "}
                  {/* ADR-008: the score states the coverage it was computed over, inside the
                      sentence that makes the claim. */}
                  {coverage ? (
                    <>
                      <span className="text-[var(--text-muted)]">{coverage.scope}</span>
                      {coverage.sample !== null && (
                        <>
                          {" "}
                          <span className="text-[var(--amber-text)]">{coverage.sample}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="text-[var(--text-faint)]">
                      Coverage was not recorded for this index, so what it was computed over is
                      unknown — reported as unknown rather than as complete.
                    </span>
                  )}
                </p>
                <Link
                  href={sectionHref(repo.id, "agents")}
                  className="group mt-md inline-flex cursor-pointer items-center gap-xs text-meta text-[var(--accent-text)] transition-opacity duration-200 hover:opacity-80"
                >
                  Run the swarm on these findings
                  <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>
          </section>
        </Reveal>

        {/* ---- Pillars --------------------------------------------------- */}
        <Reveal delay={0.06}>
          <section className="panel flex h-full flex-col justify-center gap-lg p-lg">
            <div className="flex items-center gap-sm">
              <Target className="h-3.5 w-3.5 text-[var(--text-faint)]" />
              <p className="eyebrow">Pillars · never blended</p>
            </div>
            {pillars.map((p) => {
              const meta = PILLAR_META[p.pillar];
              const score = p.score;
              const tone = score === null ? "var(--text-faint)" : band(score).color;
              return (
                <div key={p.pillar}>
                  <div className="mb-xs flex items-baseline justify-between gap-md">
                    <span className="text-meta text-[var(--text-primary)]" title={meta.question}>
                      {meta.label}
                    </span>
                    <span className="text-meta text-[var(--text-muted)]">
                      {score === null ? (
                        "not measured"
                      ) : (
                        <>
                          <span className="tnum text-[var(--text-secondary)]">{score}</span> · {rating(score)}
                        </>
                      )}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{ width: `${score ?? 0}%`, background: tone }}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        </Reveal>

        {/* ---- What is producing the list --------------------------------
            The Health Score says 72 and the stat strip says 200 findings; neither
            answers the first question a reader actually has, which is whether those
            200 are 200 problems or one problem counted 100 times. The tally is the
            answer and it fits in a row. */}
        <Reveal delay={0.12} className="lg:col-span-3">
          <section className="panel h-full p-lg">
            <div className="flex flex-wrap items-center justify-between gap-x-lg gap-y-sm">
              <div className="flex items-center gap-sm">
                <TrendingDown className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                <p className="eyebrow">What is producing the findings</p>
              </div>
              {/* Every tier, including the empty ones — "accepted 0" is a fact, and
                  omitting it reads as "not measured". */}
              <dl className="flex flex-wrap items-baseline gap-x-md gap-y-2xs">
                {TIER_KEYS.map((key) => (
                  <div key={key} className="flex items-baseline gap-2xs">
                    <dt className="text-micro text-[var(--text-muted)]">{GROUP_META[key].short}</dt>
                    <dd className="tnum text-micro" style={{ color: TIER_TONE[key] }}>
                      {breakdown.tiers[key]}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {breakdown.total === 0 ? (
              <p className="mt-md text-meta text-[var(--text-muted)]">
                No findings, so there is nothing to break down by rule.
              </p>
            ) : (
              <>
                <ul className="mt-md space-y-xs">
                  {breakdown.rows.map((row) => (
                    <li
                      key={row.rule}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-md sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_3rem_6rem_6rem]"
                    >
                      <span className="flex min-w-0 items-center gap-2xs">
                        {/* A derived id is title prose, not a rule id, so it is not dressed
                            as one: chrome that says "copy me into a baseline" on a string
                            the next index can change is the lie this label prevents. */}
                        {row.derived ? (
                          <span className="min-w-0 truncate text-micro text-[var(--text-secondary)]" title={row.title}>
                            {row.title}
                          </span>
                        ) : (
                          <code
                            title={row.rule}
                            className="min-w-0 truncate rounded-xs border border-[var(--line)] bg-[var(--surface-3)] px-2xs py-hair font-mono text-micro text-[var(--text-secondary)]"
                          >
                            {row.rule}
                          </code>
                        )}
                        {row.derived && (
                          <span
                            title="Indexed before rule ids were recorded — grouped by title text"
                            className="shrink-0 rounded-xs border border-[var(--line)] px-2xs py-hair text-micro text-[var(--text-faint)]"
                          >
                            no rule id
                          </span>
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        className="hidden h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)] sm:block"
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${row.share * 100}%`, background: TIER_TONE[row.tier] }}
                        />
                      </span>
                      <span className="tnum justify-self-end text-micro text-[var(--text-primary)] sm:justify-self-end">
                        {row.count}
                      </span>
                      <span
                        className="hidden text-micro sm:block"
                        style={{ color: TIER_TONE[row.tier] }}
                      >
                        {GROUP_META[row.tier].short}
                      </span>
                      <span className="tnum hidden text-micro text-[var(--text-muted)] sm:block">
                        {row.suppressed > 0 ? `${row.suppressed} accepted` : "—"}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="mt-md max-w-note text-meta text-[var(--text-muted)]">
                  {topRule && (
                    <>
                      One rule,{" "}
                      <span className="text-[var(--text-secondary)]">
                        {topRule.derived ? topRule.title : topRule.rule}
                      </span>
                      , is <span className="tnum">{Math.round(topRule.share * 100)}%</span> of all{" "}
                      <span className="tnum">{breakdown.total}</span> findings.{" "}
                    </>
                  )}
                  {breakdown.restRules > 0 && (
                    <>
                      <span className="tnum">{breakdown.restRules}</span> further{" "}
                      {breakdown.restRules === 1 ? "rule accounts" : "rules account"} for the
                      remaining <span className="tnum">{breakdown.restFindings}</span>.
                    </>
                  )}
                </p>

                {breakdown.derivedFindings > 0 && (
                  <p className="mt-sm max-w-note text-meta text-[var(--amber-text)]">
                    <span className="tnum">{breakdown.derivedFindings}</span> of these findings were
                    indexed before rule ids were recorded, so they are grouped by their title text
                    rather than by a rule — re-index for rule-level grouping.
                  </p>
                )}
              </>
            )}
          </section>
        </Reveal>

        {/* ---- Analysis depth -------------------------------------------- */}
        {tiers.length > 0 && (
          <Reveal delay={0.1} className="lg:col-span-2">
            <section className="panel h-full p-lg">
              <div className="flex flex-wrap items-center justify-between gap-x-lg gap-y-2xs">
                <div className="flex items-center gap-sm">
                  <Layers className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                  <p className="eyebrow">Analysis depth</p>
                </div>
                <p className="text-meta text-[var(--text-muted)]">
                  <span className="tnum text-[var(--text-secondary)]">{fullPct}%</span> read with a type
                  checker
                </p>
              </div>

              {/* One bar, segmented and labelled — the depth a line was read at is not a
                  yes/no, and a single "coverage %" hides that half a codebase can be
                  counted while only being pattern-matched. HLD 8.3 records the ladder;
                  nothing rendered it until now. */}
              <div className="mt-md flex h-2.5 gap-hair overflow-hidden rounded-full">
                {tiers.map((t) => (
                  <div
                    key={t.key}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${t.pct}%`, background: TIER_META[t.key].color }}
                    title={`${TIER_META[t.key].label}: ${t.loc.toLocaleString()} LOC (${t.pct.toFixed(1)}%)`}
                  />
                ))}
              </div>

              <dl className="mt-md flex flex-wrap gap-x-lg gap-y-sm">
                {tiers.map((t) => (
                  <div key={t.key} className="flex items-baseline gap-sm">
                    <span
                      className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-sm"
                      style={{ background: TIER_META[t.key].color }}
                      aria-hidden="true"
                    />
                    <dt className="text-micro text-[var(--text-secondary)]">{TIER_META[t.key].label}</dt>
                    <dd className="tnum text-micro text-[var(--text-muted)]">
                      {t.pct.toFixed(0)}% · {t.loc.toLocaleString()} LOC
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="mt-md max-w-note text-meta text-[var(--text-muted)]">
                {TIER_META[tiers[0].key].note}
              </p>
            </section>
          </Reveal>
        )}

        {/* ---- Highest-impact finding ------------------------------------
            The depth tile is conditional (a Markdown-only repository has no LOC
            tiers to draw), and this tile is one column of three — so when depth
            is absent the second row was a third of a card followed by two empty
            columns.

            Widening it to the full row is only half the fix: a column layout
            stretched to 1100px is the same hole with a border round it. When it
            spans the row it lays out as an action BAR — the finding on the left,
            the severity and the affordance on the right — so the width is
            occupied rather than padded. */}
        <Reveal delay={0.14} className={wide ? "lg:col-span-3" : undefined}>
          {top ? (
            <Link
              href={sectionHref(repo.id, "agents")}
              className={`panel group relative flex h-full cursor-pointer overflow-hidden p-lg transition-colors duration-200 hover:border-line-strong ${
                wide
                  ? "flex-col gap-md sm:flex-row sm:items-center sm:justify-between sm:gap-xl"
                  : "flex-col justify-between"
              }`}
            >
              {/* Raised, not inverted. On an ink surface the way to lift one tile is a
                  brighter face and an edge, not a darker one — a darker card here would
                  recede, which is the opposite of featuring it. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[var(--surface-hover)] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              />
              <div className="relative min-w-0">
                <div className="flex items-center gap-sm">
                  <Crosshair className="h-3.5 w-3.5 text-[var(--coral-text)]" />
                  <p className="eyebrow">Act on this first</p>
                </div>
                <p className="mt-md text-body text-[var(--text-primary)]">{top.title}</p>
                <p className="mt-xs truncate font-mono text-meta text-[var(--text-muted)]">
                  {top.file}
                  {top.line > 1 ? `:${top.line}` : ""}
                </p>
              </div>
              <div className={`relative flex items-center gap-sm ${wide ? "shrink-0" : "mt-lg"}`}>
                <span
                  className={`rounded-sm border px-sm py-2xs text-micro font-medium tracking-[0.08em] uppercase ${
                    (SEVERITY[top.severity] ?? SEVERITY[1]).chip
                  } ${(SEVERITY[top.severity] ?? SEVERITY[1]).tone}`}
                >
                  <span className="tnum">S{top.severity}</span> {(SEVERITY[top.severity] ?? SEVERITY[1]).label}
                </span>
                <span className="tnum text-meta text-[var(--text-muted)]">
                  ×{top.blastRadius} blast
                </span>
                <ArrowUpRight className="ml-auto h-4 w-4 text-[var(--text-faint)] transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--accent-text)]" />
              </div>
            </Link>
          ) : (
            <section className="panel flex h-full flex-col items-start justify-center gap-sm p-lg">
              <div className="flex items-center gap-sm">
                <Crosshair className="h-3.5 w-3.5 text-[var(--accent-text)]" />
                <p className="eyebrow">Nothing to act on</p>
              </div>
              <p className="max-w-note text-meta text-[var(--text-secondary)]">
                No findings were emitted for this index.
              </p>
            </section>
          )}
        </Reveal>
      </div>

      {/* ----------------------------------------------------------- STAT STRIP */}
      <Reveal>
        <dl className="mt-2xl grid grid-cols-2 border-y border-[var(--line)] sm:grid-cols-3 lg:grid-cols-5">
          {[
            { k: "Files", v: repo.graphStats?.files ?? 0 },
            { k: "Symbols", v: repo.symbolGraph?.stats.symbols ?? repo.graphStats?.nodes ?? 0 },
            { k: "Graph edges", v: repo.graphStats?.edges ?? 0 },
            { k: "Dependencies", v: repo.graphStats?.dependencies ?? 0 },
            { k: "Findings", v: repo.issues.length },
          ].map((s, i) => (
            <div
              key={s.k}
              className={`px-lg py-lg ${i > 0 ? "sm:border-l sm:border-[var(--line)]" : ""} ${
                i % 2 === 1 ? "border-l border-[var(--line)] sm:border-l" : ""
              }`}
            >
              <dt className="eyebrow">{s.k}</dt>
              <dd className="tnum mt-sm text-h3 leading-none text-[var(--text-primary)]">
                {s.v.toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>

      {repo.symbolGraph?.truncated && (
        <div className="mt-lg flex items-start gap-md rounded-lg border border-[var(--amber-400)]/25 bg-[var(--amber-400)]/[0.05] px-md py-md">
          <AlertTriangle className="mt-2xs h-4 w-4 shrink-0 text-[var(--amber-text)]" />
          <p className="max-w-note text-meta text-[var(--text-secondary)]">
            Symbol graph truncated — code intelligence covers{" "}
            <span className="tnum">{repo.symbolGraph.stats.symbols.toLocaleString()}</span> symbols
            indexed, not the whole codebase.
          </p>
        </div>
      )}

      {/* -------------------------------------------------- WHERE RISK CONCENTRATES */}
      <Reveal>
        <section className="mt-2xl">
          <div className="flex flex-wrap items-baseline justify-between gap-md">
            <h2 className="font-display text-lede tracking-tight text-[var(--text-primary)]">
              Where the risk concentrates
            </h2>
            {repo.issues.length > 0 && (
              <p className="text-meta text-[var(--text-muted)]">
                Reading <span className="tnum text-[var(--text-secondary)]">{tiered.shown}</span> of{" "}
                <span className="tnum">{tiered.total}</span>
                {tiered.hidden > 0 && (
                  <> · <span className="tnum">{tiered.hidden}</span> in closed groups</>
                )}
              </p>
            )}
          </div>
          <p className="mt-sm max-w-note text-meta text-[var(--text-muted)]">
            Ranked by severity weighted with blast radius — how many symbols reach this one through
            the graph — rather than by severity alone, and grouped by how much the detector could
            prove.
          </p>

          {repo.issues.length === 0 ? (
            <p className="mt-lg flex items-center gap-sm text-meta text-[var(--accent-text)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-fill)]" aria-hidden="true" />
              No findings detected in this index.
            </p>
          ) : (
            <>
              <div className="mt-lg">
                <TierFilterBar tiered={tiered} value={filter} onChange={setFilter} />
              </div>

              <div className="mt-lg space-y-xl">
                {tiered.groups.map((group) => (
                  <div key={group.key}>
                    <div className="flex flex-wrap items-baseline justify-between gap-md border-b border-[var(--line)] pb-sm">
                      <h3 className="text-meta text-[var(--text-primary)]">
                        {group.label}{" "}
                        <span className="tnum text-[var(--text-muted)]">{group.issues.length}</span>
                      </h3>
                      {/* A closed group is a count with a way in, not a count. */}
                      {!group.open && (
                        <button
                          type="button"
                          onClick={() => setFilter(group.key)}
                          className="group/open inline-flex cursor-pointer items-center gap-2xs text-meta text-[var(--accent-text)] transition-opacity duration-200 hover:opacity-80"
                        >
                          Show {group.short}
                          <ChevronRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover/open:translate-x-0.5" />
                        </button>
                      )}
                    </div>
                    <p className="mt-sm max-w-note text-micro text-[var(--text-muted)]">{group.note}</p>

                    {group.open && (
                      <Stagger className="mt-sm divide-y divide-[var(--line-soft)]" step={0.03}>
                        {group.issues.slice(0, GROUP_CAP).map((iss) => {
                          const sev = SEVERITY[iss.severity] ?? SEVERITY[1];
                          return (
                            <StaggerItem key={iss.id}>
                              <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-md py-md sm:grid-cols-[minmax(0,1fr)_7rem_5rem_5rem_2.5rem]">
                                <div className="min-w-0">
                                  <p className="truncate text-meta text-[var(--text-primary)]">{iss.title}</p>
                                  {/* The location is the link, not just the icon at the end of
                                      the row. `index.js:123` is what a reader reaches for — it
                                      names the destination — and until now it was inert text
                                      while the only working affordance was a 14px glyph that
                                      appears on hover. Both go to the same place. */}
                                  <p className="mt-2xs truncate font-mono text-micro text-[var(--text-muted)]">
                                    {repo.hasWorkspace ? (
                                      <Link
                                        href={editorHref(repo.id, iss.file, iss.line)}
                                        title={`Open ${findingLocation(iss)} in the editor`}
                                        className="cursor-pointer underline decoration-dotted underline-offset-2 transition-colors duration-200 hover:text-[var(--accent-text)]"
                                      >
                                        {findingLocation(iss)}
                                      </Link>
                                    ) : (
                                      findingLocation(iss)
                                    )}
                                  </p>
                                  {/* The evidence, the rule id, and the two strings you need to
                                      accept this finding — in the row, because "why do you
                                      believe this" and "how do I make it stop" are the two
                                      questions every row raises. */}
                                  <FindingEvidence issue={iss} />
                                </div>
                                <span
                                  className={`justify-self-start rounded-sm border px-sm py-2xs text-micro font-medium tracking-[0.08em] uppercase ${sev.chip} ${sev.tone}`}
                                >
                                  <span className="tnum">S{iss.severity}</span> {sev.label}
                                </span>
                                <span className="tnum hidden text-right text-meta text-[var(--text-secondary)] sm:block">
                                  ×{iss.blastRadius}
                                </span>
                                <span className="tnum hidden text-right text-meta text-[var(--text-muted)] sm:block">
                                  {iss.churn ?? "—"}
                                </span>
                                {/* Straight to the line. A finding names a file and a line and
                                    then makes you go and find them yourself, which is the one
                                    step of this workflow the product can just do.

                                    Enabled only with a live workspace: without a clone there is
                                    nothing for the editor to open, and a link that lands on an
                                    empty state is worse than a disabled control that says why. */}
                                {repo.hasWorkspace ? (
                                  <Link
                                    href={editorHref(repo.id, iss.file, iss.line)}
                                    aria-label={`Open ${iss.file} at line ${iss.line} in the editor`}
                                    title={`Open ${iss.file}:${iss.line} in the editor`}
                                    className="col-start-2 row-start-1 flex h-8 w-8 cursor-pointer items-center justify-center justify-self-end rounded-md text-[var(--text-faint)] opacity-0 transition-colors duration-200 hover:bg-[var(--surface-hover)] hover:text-[var(--accent-text)] focus-visible:opacity-100 group-hover:opacity-100 sm:col-start-5 max-sm:opacity-100"
                                  >
                                    <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                                  </Link>
                                ) : (
                                  <span
                                    title="Re-index this repository to enable the built-in editor"
                                    className="hidden h-8 w-8 items-center justify-center justify-self-end text-[var(--text-faint)] opacity-40 sm:flex"
                                  >
                                    <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                                  </span>
                                )}
                              </div>
                            </StaggerItem>
                          );
                        })}
                      </Stagger>
                    )}

                    {group.open && group.issues.length > GROUP_CAP && (
                      <Link
                        href={sectionHref(repo.id, "agents")}
                        className="mt-sm inline-block cursor-pointer text-meta text-[var(--accent-text)] transition-opacity duration-200 hover:opacity-80"
                      >
                        <span className="tnum">{group.issues.length - GROUP_CAP}</span> more in this
                        group — take them to the swarm
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </Reveal>

      {/* --------------------------------------------------------- SCORE DETAIL */}
      <Reveal>
        <section className="mt-2xl">
          <h2 className="font-display text-lede tracking-tight text-[var(--text-primary)]">
            How the score was reached
          </h2>
          <p className="mt-sm max-w-note text-meta text-[var(--text-muted)]">
            Five dimensions, each weighted, each traceable to the findings that moved it.
          </p>
          <Stagger className="mt-lg space-y-md">
            {repo.dimensions.map((d) => {
              const meta = DIMENSION_META[d.dimension as Dimension];
              const dim = band(d.score);
              return (
                <StaggerItem key={d.dimension}>
                  <div className="mb-sm flex items-baseline justify-between gap-md">
                    <span className="text-meta text-[var(--text-primary)]">
                      {meta.label}{" "}
                      <span className="text-micro text-[var(--text-muted)]">
                        · <span className="tnum">{plural(d.issueCount, "issue")}</span> · weight{" "}
                        <span className="tnum">{Math.round(meta.weight * 100)}%</span>
                      </span>
                    </span>
                    <span className="tnum text-meta" style={{ color: dim.textColor }}>
                      {d.score}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
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
        <section className="mt-2xl">
          <h2 className="font-display text-lede tracking-tight text-[var(--text-primary)]">
            Read more about {repo.name}
          </h2>
          <Stagger className="mt-lg grid gap-sm sm:grid-cols-2" step={0.05}>
            {SECTIONS.filter((s) => s.slug).map((s) => (
              <StaggerItem key={s.slug}>
                <Link
                  href={sectionHref(repo.id, s.slug)}
                  className="panel group flex h-full cursor-pointer items-start gap-md p-md transition-colors duration-200 hover:border-line-strong"
                >
                  <span className="mt-2xs flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface-2)]">
                    <s.icon className="h-4 w-4 text-[var(--text-muted)] transition-colors duration-200 group-hover:text-[var(--accent-text)]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-xs text-meta text-[var(--text-primary)]">
                      {s.label}
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)] transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--accent-text)]" />
                    </span>
                    <span className="mt-2xs block text-meta text-[var(--text-muted)]">
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
