"use client";

import { createContext, useContext } from "react";
import type { RepoDetail } from "@/lib/types";

/**
 * The indexed repository, fetched once by the section layout.
 *
 * Every section used to be a hidden `<div>` inside one 463-line page, which meant
 * all seven heavy views — Monaco, three graph renderers, the swarm, the timeline —
 * mounted on every visit whether or not you opened them. Real routes mount one.
 *
 * The layout owns the fetch so navigating between sections does not refetch: a Next
 * nested layout persists across its children, so the request happens once per repo
 * rather than once per section.
 */
const RepoContext = createContext<RepoDetail | null>(null);

export const RepoProvider = RepoContext.Provider;

export function useRepo(): RepoDetail {
  const repo = useContext(RepoContext);
  if (!repo) {
    // A section rendered outside the layout would otherwise fail later with a
    // property access on null, several frames from the actual mistake.
    throw new Error("useRepo must be used inside the repos/[id] layout");
  }
  return repo;
}

/** A reading and the word for it — colour is never the only carrier. */
export function band(s: number): { color: string; label: string } {
  if (s >= 80) return { color: "var(--signal-500)", label: "Healthy" };
  if (s >= 60) return { color: "var(--amber-400)", label: "Watch" };
  return { color: "var(--coral-500)", label: "At risk" };
}

/** Shared empty state for a section with nothing to draw. */
export function Empty({ msg }: { msg: string }) {
  return (
    <p className="rounded-xl border border-dashed border-[var(--line)] p-10 text-center text-sm text-[var(--text-muted)]">
      {msg}
    </p>
  );
}

/**
 * Section header. One shape for every section page so the sub-navigation is not the
 * only thing telling you where you are.
 */
export function SectionHead({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb?: string;
}) {
  return (
    <header className="mb-6">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="font-display mt-2 text-[1.75rem] leading-tight tracking-tight text-[var(--text-primary)]">
        {title}
      </h2>
      {blurb && (
        <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-muted)]">{blurb}</p>
      )}
    </header>
  );
}
