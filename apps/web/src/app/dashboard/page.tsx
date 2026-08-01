"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, FolderGit2, Network, Trash2 } from "lucide-react";
import { fetchRepos, deleteRepo } from "@/lib/api";
import type { RepoSummary } from "@/lib/types";
import { Stagger, StaggerItem } from "@/components/motion/primitives";

/**
 * Health bands. Signal is a good reading, amber a caution, coral a risk — the
 * three meaning-bound accents, used for the one thing each of them means.
 */
function scoreColor(s: number | null): string {
  if (s === null) return "text-[var(--text-muted)]";
  if (s >= 80) return "text-[var(--signal-500)]";
  if (s >= 60) return "text-[var(--amber-400)]";
  return "text-[var(--coral-500)]";
}

/** The same band as the channel rail down the left edge of a card. */
function scoreRail(s: number | null): string {
  if (s === null) return "bg-[var(--line-strong)]";
  if (s >= 80) return "bg-[var(--signal-500)]";
  if (s >= 60) return "bg-[var(--amber-400)]";
  return "bg-[var(--coral-500)]";
}

const BTN_PRIMARY =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-[var(--signal-500)] px-4 text-[13.5px] font-medium text-[var(--ink-900)] transition-colors duration-200 hover:bg-[var(--signal-400)]";
const BTN_GHOST =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] px-4 text-[13.5px] text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--line-strong)] hover:bg-white/[0.04] hover:text-[var(--text-primary)]";

export default function DashboardPage() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  // Render-time readings over the same list the cards below are drawn from.
  const scored = repos?.filter((r) => r.score !== null) ?? [];
  const mean = scored.length
    ? Math.round(scored.reduce((acc, r) => acc + (r.score ?? 0), 0) / scored.length)
    : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1 className="font-display mt-3 text-4xl tracking-tight text-[var(--text-primary)] sm:text-5xl">
            Indexed <em>repositories</em>
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
            Every codebase CodeGraph has measured, with the Health Score as read at its last index.
          </p>
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

      {repos !== null && repos.length > 0 && (
        <dl className="panel mb-6 grid max-w-lg grid-cols-3 divide-x divide-[var(--line)]">
          <div className="px-5 py-3.5">
            <dt className="eyebrow">Tracked</dt>
            <dd className="tnum mt-1.5 text-xl text-[var(--text-primary)]">{repos.length}</dd>
          </div>
          <div className="px-5 py-3.5">
            <dt className="eyebrow">Measured</dt>
            <dd className="tnum mt-1.5 text-xl text-[var(--text-primary)]">{scored.length}</dd>
          </div>
          <div className="px-5 py-3.5">
            <dt className="eyebrow">Mean score</dt>
            <dd className={`tnum mt-1.5 text-xl ${scoreColor(mean)}`}>{mean ?? "—"}</dd>
          </div>
        </dl>
      )}

      {repos === null ? (
        <div className="panel px-6 py-8 sm:px-8">
          <p className="eyebrow flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading index
          </p>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--text-secondary)]">
            Pulling the repository table and the latest Health Score recorded for each entry.
          </p>
          <div className="mt-7 grid gap-2.5" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[74px] rounded-xl border border-[var(--line-soft)] bg-[var(--ink-800)]"
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
        <Stagger className="grid grid-cols-1 gap-2.5">
          {repos.map((r) => {
            const processing = r.status !== "done" && r.status !== "error";
            const clickable = r.status === "done";
            const rail =
              r.status === "error"
                ? "bg-[var(--coral-500)]"
                : processing
                  ? "bg-[var(--line-strong)]"
                  : scoreRail(r.score);

            return (
              <StaggerItem key={r.id}>
                <div
                  className={`panel group relative overflow-hidden ${clickable ? "cursor-pointer" : ""}`}
                >
                  {/* `.panel` paints its own `background` and `border` shorthands from
                      unlayered CSS, which outrank any `bg-*`/`border-*` utility. The
                      hover state therefore lives on its own layer. */}
                  {clickable && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 z-0 rounded-[13px] bg-white/[0.03] opacity-0 shadow-[inset_0_0_0_1px_var(--line-strong)] transition-opacity duration-200 group-hover:opacity-100"
                    />
                  )}
                  {clickable && (
                    <Link
                      href={`/repos/${r.id}`}
                      aria-label={`Open ${r.name}`}
                      className="absolute inset-0 z-0 cursor-pointer rounded-[14px]"
                    />
                  )}
                  <span aria-hidden="true" className={`absolute inset-y-0 left-0 z-[1] w-[2px] ${rail}`} />

                  <div className="pointer-events-none relative z-[1] flex items-center justify-between gap-4 py-4 pr-3 pl-6">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <h2 className="font-display truncate text-lg tracking-tight text-[var(--text-primary)]">
                          {r.name}
                        </h2>
                        <span className="eyebrow shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 leading-none">
                          {r.sourceType}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-[var(--text-muted)]">{r.url}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-4 sm:gap-6">
                      <div className="flex w-20 flex-col items-end">
                        {processing ? (
                          <Loader2 className="h-[26px] w-[26px] animate-spin text-[var(--text-secondary)]" />
                        ) : r.status === "error" ? (
                          <span className="tnum text-[30px] leading-none text-[var(--coral-500)]">—</span>
                        ) : (
                          <span className={`tnum text-[30px] leading-none ${scoreColor(r.score)}`}>
                            {r.score ?? "—"}
                          </span>
                        )}
                        <span className="eyebrow mt-2 truncate">
                          {processing ? r.status : r.status === "error" ? "failed" : "health"}
                        </span>
                      </div>

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
                        className="pointer-events-auto relative z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border border-transparent text-[var(--text-muted)] transition-colors duration-200 hover:border-[var(--coral-500)]/25 hover:bg-[var(--coral-500)]/10 hover:text-[var(--coral-500)] disabled:cursor-not-allowed disabled:opacity-50"
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
      )}
    </div>
  );
}
