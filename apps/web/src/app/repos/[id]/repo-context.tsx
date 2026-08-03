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

/**
 * A reading and the word for it — colour is never the only carrier.
 *
 * `color` is the FILL (the dial arc, a bar) and is identical in both themes;
 * `textColor` is the same reading rendered as TEXT, driven dark enough to hold
 * against paper. They are separate fields because chartreuse at 1.21:1 on the
 * light surface is a perfectly good bar and an invisible numeral.
 */
export function band(s: number): { color: string; textColor: string; label: string } {
  if (s >= 80) return { color: "var(--signal-500)", textColor: "var(--accent-text)", label: "Healthy" };
  if (s >= 60) return { color: "var(--amber-400)", textColor: "var(--amber-text)", label: "Watch" };
  return { color: "var(--coral-500)", textColor: "var(--coral-text)", label: "At risk" };
}

/** Shared empty state for a section with nothing to draw. */
export function Empty({ msg }: { msg: string }) {
  return (
    <p className="rounded-lg border border-dashed border-[var(--line)] p-xl text-center text-meta text-[var(--text-muted)]">
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
    <header className="mb-lg">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="font-display mt-sm text-h3 tracking-tight text-[var(--text-primary)]">
        {title}
      </h2>
      {blurb && (
        <p className="mt-sm max-w-note text-meta text-[var(--text-muted)]">{blurb}</p>
      )}
    </header>
  );
}
