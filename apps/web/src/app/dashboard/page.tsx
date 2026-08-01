"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FolderGit2, Loader2, Network, Trash2 } from "lucide-react";
import { fetchRepos, deleteRepo } from "@/lib/api";
import type { RepoSummary } from "@/lib/types";
import { CountUp, Reveal, Stagger, StaggerItem } from "@/components/motion/primitives";
import { ScoreDial } from "@/components/ScoreDial";

/**
 * Health bands. Signal is a good reading, amber a caution, coral a risk — the three
 * meaning-bound accents, each used only for the one thing it means.
 *
 * The band is always rendered as a WORD as well as a colour. A dashboard that says
 * "which repo needs me first" purely in hue is unusable in greyscale and for the
 * ~8% of men who cannot separate the amber from the coral.
 */
type Band = { text: string; bg: string; rail: string; word: string; color: string };

function band(s: number | null): Band {
  if (s === null)
    return {
      text: "text-[var(--text-muted)]",
      bg: "bg-[var(--ink-600)]",
      rail: "bg-[var(--line-strong)]",
      word: "unmeasured",
      color: "var(--text-faint)",
    };
  if (s >= 80)
    return {
      text: "text-[var(--signal-500)]",
      bg: "bg-[var(--signal-500)]",
      rail: "bg-[var(--signal-500)]",
      word: "healthy",
      color: "var(--signal-500)",
    };
  if (s >= 60)
    return {
      text: "text-[var(--amber-400)]",
      bg: "bg-[var(--amber-400)]",
      rail: "bg-[var(--amber-400)]",
      word: "watch",
      color: "var(--amber-400)",
    };
  return {
    text: "text-[var(--coral-500)]",
    bg: "bg-[var(--coral-500)]",
    rail: "bg-[var(--coral-500)]",
    word: "at risk",
    color: "var(--coral-500)",
  };
}

/** Compact relative time. Absolute dates make you do arithmetic to answer "is this stale?". */
function ago(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2_592_000) return `${Math.floor(s / 86_400)}d ago`;
  return `${Math.floor(s / 2_592_000)}mo ago`;
}

/** How long the index itself took. Both timestamps are on the row already. */
function took(r: RepoSummary): string {
  if (!r.finishedAt || !r.createdAt) return "—";
  const s = (r.finishedAt - r.createdAt) / 1000;
  if (s < 0) return "—";
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const BTN_PRIMARY =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-[var(--signal-500)] px-4 text-[13.5px] font-medium text-[var(--ink-900)] transition-colors duration-200 hover:bg-[var(--signal-400)]";
const BTN_GHOST =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] px-4 text-[13.5px] text-[var(--text-secondary)] transition-colors duration-200 hover:border-line-strong hover:bg-white/[0.04] hover:text-[var(--text-primary)]";

type Order = "risk" | "recent";

export default function DashboardPage() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [order, setOrder] = useState<Order>("risk");

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Remove "${name}" from CodeGraph? This deletes its index and cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await deleteRepo(id);
      setRepos((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete repository");
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetchRepos();
        if (active) setRepos(r);
      } catch {
        if (active) setRepos([]);
      }
    };
    load();
    const iv = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, []);

  // Readings derived at render over the same list the table is drawn from, so the
  // summary can never disagree with the rows underneath it.
  const scored = repos?.filter((r) => r.score !== null) ?? [];
  const mean = scored.length
    ? Math.round(scored.reduce((acc, r) => acc + (r.score ?? 0), 0) / scored.length)
    : null;
  const attention = scored.filter((r) => (r.score ?? 100) < 60).length;
  const worst = scored.length
    ? scored.reduce((lo, r) => ((r.score ?? 100) < (lo.score ?? 100) ? r : lo))
    : null;

  /**
   * Default order is RISK, not recency.
   *
   * The question this page exists to answer is "where do I look first", and
   * insertion order answers a different one. In-flight and failed rows sort to the
   * top of the risk view because an index that never finished is the most urgent
   * thing on the page and has no score to rank it by.
   */
  const rows = [...(repos ?? [])].sort((a, b) => {
    if (order === "recent") return (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
    const rank = (r: RepoSummary) =>
      r.status === "error" ? -2 : r.status !== "done" ? -1 : (r.score ?? 101);
    return rank(a) - rank(b);
  });

  const meanBand = band(mean);
  const meanBandColor = meanBand.color;

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1 className="font-display mt-3 text-4xl tracking-tight text-[var(--text-primary)] sm:text-5xl">
            Indexed <em>repositories</em>
          </h1>
        </div>
        <div className="flex items-center gap-2.5">
          <Link href="/fleet" className={BTN_GHOST}>
            <Network className="h-4 w-4 text-[var(--violet-400)]" /> Fleet graph
          </Link>
          <Link href="/" className={BTN_PRIMARY}>
            Index a repo <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="rule-fade my-10" />

      {/* ------------------------------------------------------------- READOUT */}
      {repos !== null && repos.length > 0 && (
        <Reveal>
          <section className="panel relative mb-4 overflow-hidden">
            <div className="grid-field pointer-events-none absolute inset-0 opacity-60" />
            <div className="relative grid gap-8 p-7 sm:p-9 lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-12">
              {/* Same dial as the repo report. One reading, one shape — a gauge here and
                  a bare numeral there would make the fleet mean look like a different
                  KIND of number than the score it averages. */}
              <div className="flex items-start gap-5">
                {mean === null ? (
                  <div>
                    <p className="eyebrow">Mean health</p>
                    <p className="tnum mt-2 text-[64px] leading-none text-[var(--text-muted)]">—</p>
                    <p className="mt-3 text-[13px] text-[var(--text-muted)]">nothing measured yet</p>
                  </div>
                ) : (
                  <ScoreDial
                    value={mean}
                    color={meanBandColor}
                    size={150}
                    label="Mean health"
                    sublabel={meanBand.word}
                  />
                )}
              </div>

              <div className="flex flex-col justify-center">
                {/* Prose, not just tiles. A sentence states what the numbers mean; a grid
                    of figures leaves the reader to infer it. */}
                <p className="max-w-xl text-[14.5px] leading-relaxed text-[var(--text-secondary)]">
                  CodeGraph has measured{" "}
                  <span className="tnum text-[var(--text-primary)]">{scored.length}</span> of{" "}
                  <span className="tnum text-[var(--text-primary)]">{repos.length}</span>{" "}
                  {repos.length === 1 ? "repository" : "repositories"}. The mean Health Score reads{" "}
                  <span className={meanBand.text}>{meanBand.word}</span>
                  {worst && (
                    <>
                      , and the lowest is{" "}
                      <Link
                        href={`/repos/${worst.id}`}
                        className={`${band(worst.score).text} underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-75`}
                      >
                        {worst.name}
                      </Link>{" "}
                      at <span className="tnum">{worst.score}</span>
                    </>
                  )}
                  .{" "}
                  {attention > 0 ? (
                    <span className="text-[var(--coral-400)]">
                      <span className="tnum">{attention}</span>{" "}
                      {attention === 1 ? "repository is" : "repositories are"} below 60 and ranked
                      first below.
                    </span>
                  ) : (
                    <span className="text-[var(--text-muted)]">
                      Nothing is below 60.
                    </span>
                  )}
                </p>

                <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-4">
                  {[
                    { k: "Tracked", v: repos.length, tone: "text-[var(--text-primary)]" },
                    { k: "Measured", v: scored.length, tone: "text-[var(--text-primary)]" },
                    {
                      k: "Below 60",
                      v: attention,
                      tone: attention > 0 ? "text-[var(--coral-500)]" : "text-[var(--text-primary)]",
                    },
                  ].map((s) => (
                    <div key={s.k}>
                      <dt className="eyebrow">{s.k}</dt>
                      <dd className={`tnum mt-1.5 text-2xl leading-none ${s.tone}`}>{s.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </section>
        </Reveal>
      )}

      {/* --------------------------------------------------------------- TABLE */}
      {repos === null ? (
        <div className="panel px-6 py-8 sm:px-8">
          <p className="eyebrow flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading index
          </p>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--text-secondary)]">
            Pulling the repository table and the latest Health Score recorded for each entry.
          </p>
          <div className="mt-7 grid gap-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-14 rounded-lg border border-[var(--line-soft)] bg-[var(--ink-800)]"
                style={{ opacity: 1 - i * 0.28 }}
              />
            ))}
          </div>
          <Link href="/" className={`${BTN_GHOST} mt-7`}>
            Index a repo <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : repos.length === 0 ? (
        <div className="panel flex flex-col items-start gap-5 px-6 py-12 sm:px-10">
          <FolderGit2 className="h-6 w-6 text-[var(--text-faint)]" />
          <div>
            <p className="eyebrow">No repositories</p>
            <p className="mt-2.5 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
              Nothing has been indexed yet. Point CodeGraph at a git URL or a local folder and it
              returns a Health Score, a dependency graph, and the findings behind both.
            </p>
          </div>
          <Link href="/" className={BTN_PRIMARY}>
            Index a repo <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow">
              {order === "risk" ? "Ranked by where attention is needed" : "Most recently indexed"}
            </p>
            <div className="flex rounded-lg border border-[var(--line)] bg-[var(--ink-850)] p-0.5">
              {(["risk", "recent"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setOrder(o)}
                  aria-pressed={order === o}
                  className={`min-h-9 cursor-pointer rounded-[7px] px-3 text-[12.5px] capitalize transition-colors duration-200 ${
                    order === o
                      ? "bg-[var(--ink-600)] text-[var(--text-primary)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>

          <div className="panel overflow-hidden">
            {/* Column headers. Hidden below `sm` — a five-column header over two visible
                columns is noise, and the row labels its own cells at that width. */}
            <div className="hidden grid-cols-[minmax(0,1fr)_5rem_7rem_5.5rem_2.75rem] items-center gap-4 border-b border-[var(--line)] px-5 py-3 sm:grid">
              <span className="eyebrow">Repository</span>
              <span className="eyebrow text-right">Health</span>
              <span className="eyebrow text-right">Indexed</span>
              <span className="eyebrow text-right">Took</span>
              <span className="sr-only">Actions</span>
            </div>

            <Stagger className="divide-y divide-[var(--line-soft)]" step={0.035}>
              {rows.map((r) => {
                const processing = r.status !== "done" && r.status !== "error";
                const clickable = r.status === "done";
                const b = band(r.score);
                const isWorst = worst?.id === r.id && scored.length > 1;
                const rail =
                  r.status === "error"
                    ? "bg-[var(--coral-500)]"
                    : processing
                      ? "bg-[var(--line-strong)]"
                      : b.rail;

                return (
                  <StaggerItem key={r.id}>
                    <div className="group relative">
                      {clickable && (
                        <>
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 z-0 bg-white/[0.028] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                          />
                          {/* Stretched link: the whole row is the target, but it must not
                              wrap the delete button or the markup is a button inside an
                              anchor — invalid, and the click lands on the wrong one. */}
                          <Link
                            href={`/repos/${r.id}`}
                            aria-label={`Open ${r.name}`}
                            className="absolute inset-0 z-0 cursor-pointer"
                          />
                        </>
                      )}
                      <span aria-hidden="true" className={`absolute inset-y-0 left-0 z-[1] w-[2px] ${rail}`} />

                      <div className="pointer-events-none relative z-[1] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3.5 pr-2 pl-5 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_5.5rem_2.75rem]">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14.5px] text-[var(--text-primary)]">
                              {r.name}
                            </span>
                            {isWorst && (
                              <span
                                className="eyebrow shrink-0 rounded border px-1.5 py-0.5 leading-none"
                                style={{
                                  color: "var(--coral-400)",
                                  borderColor: "rgba(255,107,87,0.3)",
                                  background: "rgba(255,107,87,0.08)",
                                }}
                              >
                                lowest
                              </span>
                            )}
                            <span className="eyebrow hidden shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 leading-none md:inline">
                              {r.sourceType}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--text-muted)]">
                            {r.url}
                          </p>
                        </div>

                        {/* Health. Number AND word, never colour alone. */}
                        <div className="hidden flex-col items-end sm:flex">
                          {processing ? (
                            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />
                          ) : r.status === "error" ? (
                            <span className="tnum text-[19px] leading-none text-[var(--coral-500)]">—</span>
                          ) : (
                            <span className={`tnum text-[19px] leading-none ${b.text}`}>
                              {r.score ?? "—"}
                            </span>
                          )}
                          <span className="eyebrow mt-1 truncate">
                            {processing ? r.status : r.status === "error" ? "failed" : b.word}
                          </span>
                        </div>

                        <span className="hidden text-right font-mono text-[12px] text-[var(--text-muted)] sm:block">
                          {ago(r.finishedAt ?? r.createdAt)}
                        </span>
                        <span className="tnum hidden text-right text-[12px] text-[var(--text-muted)] sm:block">
                          {took(r)}
                        </span>

                        <div className="flex items-center justify-end gap-3 sm:contents">
                          {/* At <sm the four data columns collapse, so the score comes back
                              here rather than disappearing with them. */}
                          <span className={`tnum text-[17px] leading-none sm:hidden ${b.text}`}>
                            {processing ? "…" : r.status === "error" ? "—" : (r.score ?? "—")}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${r.name}`}
                            title="Remove repository"
                            disabled={deletingId === r.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDelete(r.id, r.name);
                            }}
                            className="pointer-events-auto relative z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-transparent text-[var(--text-faint)] transition-colors duration-200 hover:border-[var(--coral-500)]/25 hover:bg-[var(--coral-500)]/10 hover:text-[var(--coral-500)] disabled:cursor-not-allowed disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                          >
                            {deletingId === r.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </StaggerItem>
                );
              })}
            </Stagger>
          </div>
        </>
      )}
    </div>
  );
}
