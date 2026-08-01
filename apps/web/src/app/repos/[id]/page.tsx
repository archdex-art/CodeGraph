"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Gauge, Boxes, Network, FileWarning, Share2, LayoutGrid, CircleDot, BrainCircuit, Bot, Code2, AlertTriangle, History } from "lucide-react";
import { fetchRepo } from "@/lib/api";
import type { RepoDetail, Dimension } from "@/lib/types";
import { DIMENSION_META, PILLAR_META, pillarsFrom } from "@/lib/types";
import { CountUp, Reveal, Stagger, StaggerItem } from "@/components/motion/primitives";
import { NetworkView } from "@/components/NetworkView";
import { CirclePackView } from "@/components/CirclePackView";
import { ArchitectureView } from "@/components/ArchitectureView";
import { CodeIntelPanel } from "@/components/CodeIntelPanel";
import { AgentSwarm } from "@/components/AgentSwarm";
import { CodeEditor } from "@/components/CodeEditor";
import { TimelineView } from "@/components/TimelineView";

type ViewMode = "architecture" | "pack" | "network" | "intel" | "agents" | "editor" | "timeline";

/**
 * Severity carries a WORD as well as a colour.
 *
 * This list is the page's action queue, and a queue whose priority is encoded
 * only in hue is unreadable to anyone who cannot separate coral from amber —
 * roughly one in twelve men. The colour is the fast scan; the label is the fact.
 */
const SEVERITY: Record<number, { label: string; tone: string; chip: string }> = {
  5: { label: "Critical", tone: "text-[var(--coral-400)]", chip: "border-[var(--coral-500)]/40 bg-[var(--coral-500)]/10" },
  4: { label: "High", tone: "text-[var(--coral-400)]", chip: "border-[var(--coral-500)]/30 bg-[var(--coral-500)]/[0.06]" },
  3: { label: "Medium", tone: "text-[var(--amber-400)]", chip: "border-[var(--amber-400)]/30 bg-[var(--amber-400)]/[0.06]" },
  2: { label: "Low", tone: "text-[var(--text-muted)]", chip: "border-[var(--line)] bg-[var(--ink-700)]" },
  1: { label: "Info", tone: "text-[var(--text-muted)]", chip: "border-[var(--line)] bg-[var(--ink-700)]" },
};

/**
 * A reading and the word for it. Signal is the only "good" colour on the
 * surface, so a healthy score is the one place it belongs; amber and coral are
 * warning and risk respectively and mean nothing else anywhere on the page.
 */
function band(s: number): { color: string; label: string } {
  if (s >= 80) return { color: "var(--signal-500)", label: "Healthy" };
  if (s >= 60) return { color: "var(--amber-400)", label: "Watch" };
  return { color: "var(--coral-500)", label: "At risk" };
}

export default function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [view, setView] = useState<ViewMode>("architecture");
  // Tabs a user has opened at least once during this page visit. A visited tab
  // stays mounted (just hidden via CSS) instead of unmounting on tab switch —
  // otherwise AgentSwarm's report, CodeIntel's search/prompt, and any unsaved
  // Editor buffers reset every time you switch away and back.
  const [visited, setVisited] = useState<Set<ViewMode>>(new Set(["architecture"]));

  useEffect(() => {
    fetchRepo(id).then(setRepo).catch(() => setNotFound(true));
  }, [id]);

  function selectView(v: ViewMode) {
    setView(v);
    setVisited((prev) => (prev.has(v) ? prev : new Set(prev).add(v)));
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <p className="eyebrow mb-3">404</p>
        <p className="text-[var(--text-secondary)]">
          Repository not found.{" "}
          <Link
            href="/dashboard"
            className="cursor-pointer text-[var(--signal-500)] underline decoration-[var(--signal-500)]/30 underline-offset-4 transition-colors duration-200 hover:decoration-[var(--signal-500)]"
          >
            Back to dashboard
          </Link>
        </p>
      </div>
    );
  }
  if (!repo) {
    return (
      <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--signal-500)]" /> Loading report…
      </div>
    );
  }

  // Derived, never stored — see pillarsFrom. Same function the scorer uses, same data.
  const pillars = pillarsFrom(repo.dimensions ?? []);
  const surfaced = pillars.find((p) => PILLAR_META[p.pillar].surfaced);
  /**
   * The headline is DERIVED from the stored dimensions, not read from the stored `score`.
   *
   * That column holds whatever the model produced when the repo was indexed — for anything
   * indexed before the pillar split, a blend that included maintainability. Reading it would
   * put an old-model headline directly above new-model pillar numbers computed from the same
   * row, which is the worst of both: inconsistent AND unexplainable.
   *
   * Deriving makes every existing repo show the correct number with no re-index. Falls back to
   * the stored score only when dimensions are missing entirely (a row from before that column
   * existed), where there is nothing to derive from.
   */
  const overall = surfaced?.score ?? repo.score ?? 0;
  const wide = view === "editor";
  const reading = band(overall);

  return (
    <div className={`mx-auto px-6 py-12 ${wide ? "max-w-[1600px]" : "max-w-5xl"}`}>
      <Link
        href="/dashboard"
        className="mb-8 inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--text-muted)] transition-colors duration-200 hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" /> Dashboard
      </Link>

      <div className="mb-10">
        <p className="eyebrow mb-2.5">Repository report</p>
        <h1 className="font-display text-4xl tracking-tight text-[var(--text-primary)] sm:text-5xl">{repo.name}</h1>
        {repo.sourceType === "git" ? (
          <a
            href={repo.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block cursor-pointer font-mono text-[13px] text-[var(--text-muted)] transition-colors duration-200 hover:text-[var(--signal-500)]"
          >
            {repo.url}
          </a>
        ) : (
          <span className="mt-2 inline-block font-mono text-[13px] text-[var(--text-muted)]">local · {repo.url}</span>
        )}
      </div>

      {/* The hero readout, then the graph census beside it. */}
      <div className="mb-6 grid gap-6 lg:grid-cols-5">
        <Reveal className="lg:col-span-2">
          <div className="panel relative h-full overflow-hidden p-7">
            {/* The light comes off the numeral, not the corner: the glow is
                positioned behind the reading and tinted by its band, so the
                panel looks lit by the measurement rather than decorated. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-6 -left-10 h-56 w-56 rounded-full"
              style={{ background: `radial-gradient(circle, color-mix(in oklab, ${reading.color} 11%, transparent), transparent 68%)` }}
            />
            <div className="relative">
              <div className="mb-6 flex items-center gap-2">
                <Gauge className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                <span className="eyebrow">Codebase health score</span>
              </div>

              <div className="flex items-end gap-2">
                <div className="leading-[0.85]" style={{ color: reading.color }}>
                  <CountUp to={overall} className="tnum text-[72px] font-normal" />
                </div>
                <span className="tnum pb-1.5 text-xl text-[var(--text-faint)]">/100</span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: reading.color }}
                  aria-hidden="true"
                />
                {/* The band is named, not just coloured. */}
                <span className="text-[13px] font-medium" style={{ color: reading.color }}>{reading.label}</span>
                {/* Naming what the number measures. It is the defect-risk pillar alone (PLAN.md
                    §5.1) — maintainability used to be 22% of it, which made the headline partly a
                    tidiness score while being read as risk. */}
                <span className="text-[13px] text-[var(--text-muted)]">{PILLAR_META.defect_risk.question}</span>
              </div>

              {pillars.some((p) => !PILLAR_META[p.pillar].surfaced) && (
                <>
                  <div className="rule-fade my-5" />
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {pillars
                      .filter((p) => !PILLAR_META[p.pillar].surfaced)
                      .map((p) => (
                        <span key={p.pillar} className="flex items-baseline gap-2" title={PILLAR_META[p.pillar].question}>
                          <span className="eyebrow">{PILLAR_META[p.pillar].label}</span>
                          {/* Not folded into the headline, and not rendered as a pass when nothing
                              was measured — an unscored pillar reads "n/a", never 100. */}
                          <span className={`tnum text-[13px] ${p.score === null ? "text-[var(--text-faint)]" : "text-[var(--text-secondary)]"}`}>
                            {p.score === null ? "n/a" : p.score}
                          </span>
                        </span>
                      ))}
                  </div>
                </>
              )}

              {/* ADR-008: the score reports its own coverage, so one computed over a partial scan
                  cannot masquerade as one computed over the whole repository. */}
              <div className="mt-5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                {repo.coverage ? (
                  <span
                    title={
                      `${repo.coverage.filesAnalysed} of ${repo.coverage.filesSeen} files scanned · ` +
                      `${repo.coverage.skippedNoLanguage} unsupported language · ` +
                      `${repo.coverage.skippedTooLarge} over the size cap · ` +
                      `${repo.coverage.skippedUnreadable} unreadable`
                    }
                  >
                    Scored over{" "}
                    <span className="tnum text-[var(--text-secondary)]">
                      {repo.coverage.filesSeen === 0
                        ? "—"
                        : `${Math.round((repo.coverage.filesAnalysed / repo.coverage.filesSeen) * 100)}%`}
                    </span>{" "}
                    of files · <span className="tnum">{repo.coverage.locAnalysed.toLocaleString()}</span> LOC
                    {/* A truncated walk is the one case where the denominator itself is unknown,
                        so it is called out rather than folded into a percentage. */}
                    {repo.coverage.capHit && (
                      <span className="text-[var(--amber-400)]"> · scan hit the file cap</span>
                    )}
                  </span>
                ) : (
                  // Absent coverage is UNKNOWN, never 100%. Repos indexed before ADR-008 land here.
                  <span className="text-[var(--text-faint)]" title="This repo was indexed before coverage was recorded. Re-index to measure it.">
                    Coverage not recorded for this index
                  </span>
                )}
              </div>
            </div>
          </div>
        </Reveal>

        <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-3" delay={0.1}>
          <Stat icon={<Network className="h-3.5 w-3.5 text-[var(--violet-400)]" />} label="Graph nodes" value={repo.graphStats?.nodes || 0} />
          <Stat icon={<Boxes className="h-3.5 w-3.5 text-[var(--violet-400)]" />} label="Graph edges" value={repo.graphStats?.edges || 0} />
          <Stat label="Files" value={repo.graphStats?.files || 0} />
          <Stat label="Lines of code" value={repo.loc} />
          <Stat label="Directories" value={repo.graphStats?.dirs || 0} />
          <Stat label="Dependencies" value={repo.graphStats?.dependencies || 0} />
          <Stat label="Issues found" value={repo.issues.length} />
          <Stat label="Languages" value={repo.languages?.length || 0} />
        </Stagger>
      </div>

      {repo.symbolGraph?.truncated && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-[var(--amber-400)]/25 bg-[var(--amber-400)]/[0.05] px-4 py-3.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--amber-400)]" />
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--amber-400)]">Partial results.</span> This repository has more symbols than the{" "}
            <span className="tnum">{repo.symbolGraph.stats.symbols.toLocaleString()}</span>-symbol
            analysis cap — the health score, agent findings, and code graph below only reflect the first{" "}
            <span className="tnum">{repo.symbolGraph.stats.symbols.toLocaleString()}</span> symbols indexed, not the whole codebase.
          </p>
        </div>
      )}

      {/* Codebase visualization (3 views) */}
      <div className="mb-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow mb-1.5 flex items-center gap-2">
              <Share2 className="h-3 w-3" /> Channel
            </p>
            <h2 className="font-display text-2xl tracking-tight text-[var(--text-primary)]">Codebase intelligence</h2>
          </div>
          <div className="inline-flex flex-wrap gap-1 rounded-xl border border-[var(--line)] bg-[var(--ink-850)] p-1">
            <ViewTab active={view === "architecture"} onClick={() => selectView("architecture")} icon={<LayoutGrid className="w-4 h-4" />} label="Architecture" />
            <ViewTab active={view === "pack"} onClick={() => selectView("pack")} icon={<CircleDot className="w-4 h-4" />} label="Circle pack" />
            <ViewTab active={view === "network"} onClick={() => selectView("network")} icon={<Network className="w-4 h-4" />} label="Network" />
            <ViewTab active={view === "intel"} onClick={() => selectView("intel")} icon={<BrainCircuit className="w-4 h-4" />} label="Code Intel" />
            <ViewTab active={view === "agents"} onClick={() => selectView("agents")} icon={<Bot className="w-4 h-4" />} label="Agents" />
            <ViewTab active={view === "editor"} onClick={() => selectView("editor")} icon={<Code2 className="w-4 h-4" />} label="Editor" />
            <ViewTab active={view === "timeline"} onClick={() => selectView("timeline")} icon={<History className="w-4 h-4" />} label="Timeline" />
          </div>
        </div>

        {/* Each visited tab stays mounted (hidden via CSS, not unmounted) so
            in-flight state — agent reports, code-intel search, editor tabs —
            survives switching away and back. */}
        {visited.has("architecture") && (
          <div className={view === "architecture" ? "" : "hidden"}>
            {repo.modules && repo.modules.nodes.length > 0
              ? <ArchitectureView modules={repo.modules} />
              : <Empty msg="No module structure detected." />}
          </div>
        )}

        {visited.has("pack") && (
          <div className={view === "pack" ? "" : "hidden"}>
            {repo.tree && repo.tree.children && repo.tree.children.length > 0
              ? <CirclePackView tree={repo.tree} />
              : <Empty msg="No file tree available." />}
          </div>
        )}

        {visited.has("network") && (
          <div className={view === "network" ? "" : "hidden"}>
            {repo.viz && repo.viz.nodes.length > 0
              ? <NetworkView graph={repo.viz} />
              : <Empty msg="No import network for this repository." />}
          </div>
        )}

        {visited.has("intel") && (
          <div className={view === "intel" ? "" : "hidden"}>
            <CodeIntelPanel repoId={repo.id} graph={repo.symbolGraph} />
          </div>
        )}

        {visited.has("agents") && (
          <div className={view === "agents" ? "" : "hidden"}>
            <AgentSwarm repoId={repo.id} />
          </div>
        )}

        {visited.has("editor") && (
          <div className={view === "editor" ? "" : "hidden"}>
            {repo.hasWorkspace
              ? <CodeEditor key={repo.id} repo={repo} visible={view === "editor"} />
              : <Empty msg="No live workspace for this repository yet — re-index it to enable the built-in editor." />}
          </div>
        )}

        {visited.has("timeline") && (
          <div className={view === "timeline" ? "" : "hidden"}>
            <TimelineView repoId={repo.id} />
          </div>
        )}
      </div>

      {view !== "editor" && (
        <>
          {/* Dimensions */}
          <div className="panel mb-6 p-6">
            <p className="eyebrow mb-1.5">Breakdown</p>
            <h2 className="font-display mb-5 text-xl tracking-tight text-[var(--text-primary)]">Score breakdown</h2>
            <Stagger className="space-y-4">
              {repo.dimensions.map((d) => {
                const meta = DIMENSION_META[d.dimension as Dimension];
                const dim = band(d.score);
                return (
                  <StaggerItem key={d.dimension}>
                    <div className="mb-2 flex items-baseline justify-between gap-4">
                      <span className="text-sm text-[var(--text-primary)]">
                        {meta.label}{" "}
                        <span className="text-xs text-[var(--text-muted)]">
                          · <span className="tnum">{d.issueCount}</span> issues · weight{" "}
                          <span className="tnum">{Math.round(meta.weight * 100)}%</span>
                        </span>
                      </span>
                      <span className="tnum text-sm" style={{ color: dim.color }}>{d.score}</span>
                    </div>
                    {/* The rail is a measuring track, so it keeps its full width
                        visible and the fill reports against it. */}
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ink-700)]">
                      <div className="h-full rounded-full" style={{ width: `${d.score}%`, background: dim.color }} />
                    </div>
                  </StaggerItem>
                );
              })}
            </Stagger>
          </div>

          {/* Languages */}
          {repo.languages && repo.languages.length > 0 && (
            <div className="panel mb-6 p-6">
              <p className="eyebrow mb-1.5">Composition</p>
              <h2 className="font-display mb-5 text-xl tracking-tight text-[var(--text-primary)]">Languages</h2>
              <div className="flex flex-wrap gap-2">
                {repo.languages.slice(0, 3).map((l) => (
                  <span key={l.language} className="rounded-full border border-[var(--line)] bg-[var(--ink-800)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                    {l.language} <span className="tnum text-[var(--text-muted)]">· {l.loc.toLocaleString()} LOC</span>
                  </span>
                ))}
                {repo.languages.length > 3 && (
                  <span className="rounded-full border border-[var(--line-soft)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
                    +<span className="tnum">{repo.languages.length - 3}</span> more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Top issues */}
          <div className="panel p-6">
            <p className="eyebrow mb-1.5 flex items-center gap-2">
              <FileWarning className="h-3 w-3" /> Findings
            </p>
            <h2 className="font-display text-xl tracking-tight text-[var(--text-primary)]">Top issues by impact</h2>
            <p className="mt-1 mb-5 text-xs text-[var(--text-muted)]">Ranked by severity × blast radius (graph fan-in).</p>
            {repo.issues.length === 0 ? (
              <p className="flex items-center gap-2.5 text-sm text-[var(--signal-500)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--signal-500)]" aria-hidden="true" />
                No issues detected. Clean codebase.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--line-soft)]">
                {repo.issues.slice(0, 40).map((iss) => {
                  const sev = SEVERITY[iss.severity] ?? SEVERITY[1];
                  return (
                    <li key={iss.id} className="flex items-start gap-3 py-3">
                      {/* Colour AND word: S-number for the scan, label for the fact. */}
                      <span className={`mt-0.5 shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium tracking-[0.08em] uppercase ${sev.chip} ${sev.tone}`}>
                        <span className="tnum">S{iss.severity}</span> {sev.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-[var(--text-primary)]">{iss.title}</div>
                        <div className="truncate font-mono text-xs text-[var(--text-muted)]">
                          {iss.file}{iss.line > 1 ? `:${iss.line}` : ""}
                        </div>
                      </div>
                      <span className="mt-1 shrink-0 text-[10px] text-[var(--text-muted)]">
                        <span className="tnum">×{iss.blastRadius}</span> blast
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: number }) {
  return (
    <StaggerItem className="panel p-4">
      {/* Fixed label height so a two-line label ("Graph nodes") does not push
          its number out of line with the single-line tiles beside it. */}
      <div className="mb-2 flex min-h-9 items-start gap-1.5">
        {icon}
        <span className="eyebrow">{label}</span>
      </div>
      <div className="tnum text-xl text-[var(--text-primary)]">{value.toLocaleString()}</div>
    </StaggerItem>
  );
}


function ViewTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors duration-200 ${
        active
          ? "bg-[var(--ink-600)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--ink-700)] hover:text-[var(--text-primary)]"
      }`}
    >
      <span className={active ? "text-[var(--signal-500)]" : "text-[var(--text-muted)]"}>{icon}</span>
      <span className="hidden sm:inline">{label}</span>
      {/* The selected channel is marked by a signal hairline, not just a fill. */}
      {active && <span className="absolute inset-x-2.5 bottom-1 h-px bg-[var(--signal-500)]" aria-hidden="true" />}
    </button>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <p className="rounded-xl border border-dashed border-[var(--line)] p-10 text-center text-sm text-[var(--text-muted)]">{msg}</p>
  );
}
