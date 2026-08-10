"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, UserRound, Users } from "lucide-react";
import { ownershipReviewers, ownershipSummary, type OwnershipSummary, type ReviewerSuggestion } from "@/lib/api";
import { Empty, SectionHead, useRepo } from "../repo-context";

/**
 * Ownership: who knows this code, and where nobody does any more.
 *
 * EVERY NUMBER HERE IS A SHARE OF COMMITS, not of lines, and the page says so rather than
 * leaving a percentage to be read as something stronger. Git attributes a commit to a file;
 * per-line authorship for a whole tree means a blame per file, which the index does not run.
 * "Owns 62%" therefore means "made 62% of the commits that touched this", which is the standard
 * proxy and is not the same claim.
 *
 * The report is computed at index time, so a repository indexed before it existed has none —
 * the route answers 409 and this renders that as "re-index", never as "no owners".
 */

const DAY_MS = 86_400_000;

/** Files listed under stale areas. The report already caps at 100; this is what fits a page. */
const SHOWN_STALE = 25;

function relativeDay(epochSeconds: number): string {
  const days = Math.round((Date.now() - epochSeconds * 1000) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

function Bar({ share }: { share: number }) {
  const pct = Math.round(share * 100);
  return (
    <span className="inline-flex items-center gap-2xs" title={`${pct}% of commits touching this file`}>
      <span className="inline-block h-1.5 w-16 rounded-full bg-[var(--line)]" aria-hidden>
        <span
          className="block h-full rounded-full bg-[var(--accent-fill)]"
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </span>
      {/* The number is the accessible carrier; the bar is decoration. */}
      <span className="tabular-nums text-meta text-[var(--text-secondary)]">{pct}%</span>
    </span>
  );
}

export default function OwnershipPage() {
  const repo = useRepo();
  const [data, setData] = useState<OwnershipSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * DERIVED, not set inside the effect. `setLoading(true)` in an effect body is a cascading
   * render, and it also encoded the state twice: "loading" is exactly "the data I hold is not
   * for the repo I am rendering", which this compares directly and cannot get out of step.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loading = loadedFor !== repo.id;

  const [files, setFiles] = useState("");
  const [reviewers, setReviewers] = useState<ReviewerSuggestion[] | null>(null);
  const [reviewerError, setReviewerError] = useState<string | null>(null);
  const [reviewersLoading, setReviewersLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ownershipSummary(repo.id)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load ownership");
      })
      .finally(() => {
        // Marks the data as belonging to THIS repo, which is what ends the loading state.
        if (!cancelled) setLoadedFor(repo.id);
      });
    return () => {
      cancelled = true;
    };
  }, [repo.id]);

  const parsedFiles = useMemo(
    () => files.split(/[\n,]/).map((f) => f.trim()).filter(Boolean),
    [files],
  );

  async function askReviewers(): Promise<void> {
    if (parsedFiles.length === 0) return;
    setReviewersLoading(true);
    setReviewerError(null);
    try {
      const res = await ownershipReviewers(repo.id, parsedFiles);
      setReviewers(res.reviewers);
    } catch (e: unknown) {
      setReviewers(null);
      setReviewerError(e instanceof Error ? e.message : "Failed to load reviewers");
    } finally {
      setReviewersLoading(false);
    }
  }

  return (
    <div className="space-y-xl">
      <SectionHead
        eyebrow="Intelligence"
        title="Ownership"
        blurb="Who has touched this code, where knowledge has left the building, and who should review a change."
      />

      {loading ? (
        <p className="flex items-center gap-xs text-meta text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading history…
        </p>
      ) : error ? (
        // The route's own message. A 409 says "re-index"; anything else is a real failure. Both
        // are shown verbatim rather than flattened into an empty state that would read as
        // "this repository has no owners".
        <Empty msg={error} />
      ) : data === null ? (
        <Empty msg="No ownership data." />
      ) : (
        <>
          <p className="text-meta text-[var(--text-secondary)]">
            <b className="text-[var(--text-primary)]">{data.commitsAnalysed.toLocaleString()}</b> commits
            over the last {data.windowDays} days, from{" "}
            <b className="text-[var(--text-primary)]">{data.authors.length}</b> author
            {data.authors.length === 1 ? "" : "s"}. Shares are of <b>commits touching a file</b>, not
            of lines.
            {data.truncated ? " A bound was hit, so this is a partial view." : ""}
          </p>

          <section>
            <h3 className="eyebrow mb-sm flex items-center gap-2xs">
              <Users className="h-3.5 w-3.5" aria-hidden /> Contributors
            </h3>
            {data.authors.length === 0 ? (
              <Empty msg="Analysed, but the history window contains no commits — a shallow clone, or an inactive repository." />
            ) : (
              <ul className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
                {data.authors.map((a) => (
                  <li key={a.email || a.name} className="flex flex-wrap items-baseline gap-x-md gap-y-2xs p-md">
                    <span className="font-medium text-[var(--text-primary)]">{a.name}</span>
                    <span className="tabular-nums text-meta text-[var(--text-secondary)]">
                      {a.commits.toLocaleString()} commit{a.commits === 1 ? "" : "s"}
                    </span>
                    <span className="text-meta text-[var(--text-muted)]">
                      {a.filesTouched.toLocaleString()} file{a.filesTouched === 1 ? "" : "s"}
                    </span>
                    <span className="ml-auto text-meta text-[var(--text-muted)]">
                      last commit {relativeDay(a.lastAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="eyebrow mb-sm">Orphaned areas</h3>
            <p className="mb-sm text-meta text-[var(--text-muted)]">
              Files whose every owner has stopped committing in the recent window. Old is not the
              same as abandoned — a file nobody has needed to touch is merely stale, and is not
              listed here.
            </p>
            {data.stale.length === 0 ? (
              <Empty msg="No orphaned files — every file still has an active owner." />
            ) : (
              <ul className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
                {data.stale.slice(0, SHOWN_STALE).map((f) => (
                  <li key={f.path} className="flex flex-wrap items-baseline gap-x-md gap-y-2xs p-md">
                    <code className="text-meta text-[var(--text-primary)]">{f.path}</code>
                    <span className="text-meta text-[var(--text-muted)]">
                      {f.staleDays === null ? "age unknown" : `${f.staleDays} days untouched`}
                    </span>
                    <span className="text-meta text-[var(--text-muted)]">
                      bus factor {f.busFactor}
                    </span>
                    <span className="ml-auto flex items-center gap-xs">
                      {f.owners.slice(0, 2).map((o) => (
                        <span key={o.author} className="flex items-center gap-2xs">
                          <span className="text-meta text-[var(--text-secondary)]">{o.author}</span>
                          <Bar share={o.share} />
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="eyebrow mb-sm flex items-center gap-2xs">
              <UserRound className="h-3.5 w-3.5" aria-hidden /> Who should review this?
            </h3>
            <p className="mb-sm text-meta text-[var(--text-muted)]">
              Ranked over real history: ownership of the files you name, how recently each person
              touched that area, and what else changes alongside it. Anyone inactive in the window
              is excluded — routing a review to someone who left is worse than routing it nowhere.
            </p>
            <textarea
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={"src/lib/store.ts\nsrc/lib/authz.ts"}
              aria-label="Changed files, one per line"
              className="w-full rounded-lg border border-[var(--line)] bg-transparent p-md font-mono text-meta text-[var(--text-primary)]"
            />
            <button
              type="button"
              onClick={() => void askReviewers()}
              disabled={parsedFiles.length === 0 || reviewersLoading}
              className="mt-sm rounded-lg border border-[var(--line)] px-md py-xs text-meta text-[var(--text-primary)] disabled:opacity-50"
            >
              {reviewersLoading ? "Reading history…" : `Suggest reviewers for ${parsedFiles.length} file(s)`}
            </button>

            {reviewerError !== null && <div className="mt-md"><Empty msg={reviewerError} /></div>}
            {reviewers !== null && reviewers.length === 0 && (
              <div className="mt-md">
                <Empty msg="No suggestion. Nobody active in the window has history on those files — which is an answer, not an omission." />
              </div>
            )}
            {reviewers !== null && reviewers.length > 0 && (
              <ul className="mt-md space-y-sm">
                {reviewers.map((r) => (
                  <li key={r.author} className="rounded-lg border border-[var(--line)] p-md">
                    <div className="flex items-baseline gap-xs">
                      <span className="font-medium text-[var(--text-primary)]">{r.author}</span>
                      {/* A RANKING, not a probability — labelled so nobody reads 0.99 as certainty. */}
                      <span className="tabular-nums text-meta text-[var(--text-muted)]">
                        rank score {r.score.toFixed(2)}
                      </span>
                    </div>
                    <ul className="mt-2xs list-disc pl-lg text-meta text-[var(--text-secondary)]">
                      {r.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
