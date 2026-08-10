"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import type { Issue } from "@/lib/types";
import type { FindingGroup, TierFilter } from "@/lib/findings";
import { groupByTier, parseTierFilter } from "@/lib/findings";
import { FindingEvidence } from "@/components/FindingEvidence";
import { TierFilterBar } from "@/components/TierFilterBar";

/**
 * The findings, in the editor: confidence outside, file inside.
 *
 * The file grouping is the answer to "what is wrong with the file I am in", which is the
 * question this rail exists for, and it is kept. What sits above it now is the tier,
 * because on this repository the rail was 200 rows of which 118 are heuristics — a
 * per-file list that mixes a proven finding with six guesses makes the reader grade every
 * row themselves, and the reliable response to that is to stop opening the panel.
 *
 * So the same structure the report uses applies here: high and medium open, low and
 * accepted collapsed behind their counts, one shared `?tier=` param. Sharing the param
 * with the report is deliberate — a reader who opened the low group there and clicked
 * into the editor is still looking at the low group.
 *
 * Files are ordered by their worst finding, then by count — so the file that needs
 * attention is at the top of its tier without the rows losing their grouping.
 */
const SEVERITY: Record<number, { label: string; tone: string; dot: string }> = {
  5: { label: "Critical", tone: "text-[var(--coral-text)]", dot: "bg-[var(--coral-500)]" },
  4: { label: "High", tone: "text-[var(--coral-text)]", dot: "bg-[var(--coral-500)]" },
  3: { label: "Medium", tone: "text-[var(--amber-text)]", dot: "bg-[var(--amber-400)]" },
  2: { label: "Low", tone: "text-[var(--text-secondary)]", dot: "bg-[var(--text-muted)]" },
  1: { label: "Info", tone: "text-[var(--text-muted)]", dot: "bg-[var(--text-faint)]" },
};

interface FileGroup {
  file: string;
  list: Issue[];
}

function byFile(issues: readonly Issue[]): FileGroup[] {
  const buckets = new Map<string, Issue[]>();
  for (const issue of issues) {
    const bucket = buckets.get(issue.file);
    if (bucket) bucket.push(issue);
    else buckets.set(issue.file, [issue]);
  }
  return [...buckets.entries()]
    .map(([file, list]) => ({
      file,
      list: [...list].sort((a, b) => b.severity - a.severity || a.line - b.line),
      worst: Math.max(...list.map((i) => i.severity)),
    }))
    .sort((a, b) => b.worst - a.worst || b.list.length - a.list.length || a.file.localeCompare(b.file));
}

export function IssuesPanel({
  issues,
  activePath,
  onOpenIssue,
}: {
  issues: Issue[];
  activePath: string | null;
  /** Same signature as the search panel's — the editor already knows how to reveal a line. */
  onOpenIssue: (path: string, line: number) => void;
}) {
  // `replace`, and the editor's own `file`/`line` params are preserved: changing which
  // findings you are reading must not close the file you are reading them against.
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const filter = parseTierFilter(search.get("tier"));
  const setFilter = (next: TierFilter) => {
    const params = new URLSearchParams(search);
    if (next === "default") params.delete("tier");
    else params.set("tier", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const tiered = useMemo(() => groupByTier(issues, filter), [issues, filter]);
  const files = useMemo(
    () => new Map(tiered.groups.map((g) => [g.key, byFile(g.issues)] as const)),
    [tiered]
  );

  // Collapsed by default would hide the point of the panel; open by default with a
  // per-file toggle keeps a 40-file repository navigable without hiding a 2-file one.
  // Keyed by tier as well as file: one file can hold findings in two tiers.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (issues.length === 0) {
    return (
      <div className="p-md text-meta">
        <div className="mb-md text-meta uppercase tracking-wide text-[var(--text-secondary)]">Issues</div>
        <p className="flex items-center gap-sm text-meta text-[var(--accent-text)]">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          No findings in this index.
        </p>
      </div>
    );
  }

  return (
    <div className="p-md text-meta">
      <div className="mb-sm flex items-center justify-between">
        <span className="text-meta uppercase tracking-wide text-[var(--text-secondary)]">Issues</span>
        <span className="tnum text-micro text-[var(--text-muted)]">
          {tiered.shown} of {tiered.total}
        </span>
      </div>

      <TierFilterBar tiered={tiered} value={filter} onChange={setFilter} compact />

      <div className="mt-md space-y-md">
        {tiered.groups.map((group) => (
          <div key={group.key}>
            <TierHeader group={group} onOpen={() => setFilter(group.key)} />

            {group.open && (
              <div className="mt-2xs space-y-2xs">
                {(files.get(group.key) ?? []).map(({ file, list }) => {
                  const key = `${group.key}:${file}`;
                  const isCollapsed = collapsed.has(key);
                  const inThisFile = file === activePath;
                  return (
                    <div key={key}>
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={!isCollapsed}
                        title={file}
                        className={`flex w-full min-w-0 cursor-pointer items-center gap-2xs rounded-sm px-2xs py-2xs text-left transition-colors duration-200 hover:bg-[var(--surface-hover)] ${
                          inThisFile ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
                        }`}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" />
                        )}
                        {/* The file's own name is what you scan for; the directory is context,
                            so it is dimmed rather than truncated away from the left. */}
                        <span className="min-w-0 flex-1 truncate font-mono text-micro" dir="rtl">
                          {file}
                        </span>
                        <span className="tnum shrink-0 rounded-xs bg-[var(--surface-4)] px-2xs text-micro text-[var(--text-muted)]">
                          {list.length}
                        </span>
                      </button>

                      {!isCollapsed && (
                        <ul className="ml-sm border-l border-[var(--line-soft)] pl-2xs">
                          {list.map((issue) => {
                            const sev = SEVERITY[issue.severity] ?? SEVERITY[1];
                            return (
                              <li key={issue.id} className="py-2xs">
                                {/* The evidence carries its own copy buttons, so the row is a
                                    div with a button in it rather than a button — a button
                                    inside a button is invalid and Firefox drops the inner one. */}
                                <button
                                  type="button"
                                  onClick={() => onOpenIssue(issue.file, issue.line)}
                                  title={`${sev.label} · ${issue.title} — open ${issue.file}:${issue.line}`}
                                  className="flex w-full min-w-0 cursor-pointer items-start gap-2xs rounded-sm px-2xs text-left transition-colors duration-200 hover:bg-[var(--surface-hover)]"
                                >
                                  <span
                                    className={`mt-2xs h-1.5 w-1.5 shrink-0 rounded-full ${sev.dot}`}
                                    aria-hidden="true"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-micro text-[var(--text-secondary)]">
                                      {issue.title}
                                    </span>
                                    <span className={`tnum text-micro ${sev.tone}`}>
                                      {sev.label} · line {issue.line}
                                    </span>
                                  </span>
                                </button>
                                <FindingEvidence issue={issue} compact className="px-2xs" />
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A closed tier is a count you can open, never a count you cannot. */
function TierHeader({ group, onOpen }: { group: FindingGroup; onOpen: () => void }) {
  const count = (
    <span className="tnum shrink-0 rounded-xs bg-[var(--surface-4)] px-2xs text-micro text-[var(--text-muted)]">
      {group.issues.length}
    </span>
  );

  if (group.open) {
    return (
      <div className="flex items-center gap-2xs px-2xs" title={group.note}>
        <span className="flex-1 text-micro uppercase tracking-wide text-[var(--text-muted)]">
          {group.short}
        </span>
        {count}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={group.note}
      className="flex w-full cursor-pointer items-center gap-2xs rounded-sm px-2xs py-2xs text-left transition-colors duration-200 hover:bg-[var(--surface-hover)]"
    >
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" />
      <span className="flex-1 text-micro uppercase tracking-wide text-[var(--text-muted)]">
        {group.short}
      </span>
      {count}
    </button>
  );
}
