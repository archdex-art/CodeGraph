"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import type { Issue } from "@/lib/types";

/**
 * The findings, in the editor, grouped by the file they are in.
 *
 * Grouped by FILE rather than listed by severity, which is how the report already
 * ranks them. The report answers "what should I look at first"; this panel answers
 * "what is wrong with the file I am in", and a flat severity list makes that second
 * question require a scan of the whole list. The file is also the unit the editor
 * opens, so the group header and the click target are the same thing.
 *
 * Files are ordered by their worst finding, then by count — so the file that needs
 * attention is still at the top without the individual rows losing their grouping.
 */
const SEVERITY: Record<number, { label: string; tone: string; dot: string }> = {
  5: { label: "Critical", tone: "text-[var(--coral-text)]", dot: "bg-[var(--coral-500)]" },
  4: { label: "High", tone: "text-[var(--coral-text)]", dot: "bg-[var(--coral-500)]" },
  3: { label: "Medium", tone: "text-[var(--amber-text)]", dot: "bg-[var(--amber-400)]" },
  2: { label: "Low", tone: "text-[var(--text-secondary)]", dot: "bg-[var(--text-muted)]" },
  1: { label: "Info", tone: "text-[var(--text-muted)]", dot: "bg-[var(--text-faint)]" },
};

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
  const groups = useMemo(() => {
    const byFile = new Map<string, Issue[]>();
    for (const issue of issues) {
      const bucket = byFile.get(issue.file);
      if (bucket) bucket.push(issue);
      else byFile.set(issue.file, [issue]);
    }
    return [...byFile.entries()]
      .map(([file, list]) => ({
        file,
        list: [...list].sort((a, b) => b.severity - a.severity || a.line - b.line),
        worst: Math.max(...list.map((i) => i.severity)),
      }))
      .sort((a, b) => b.worst - a.worst || b.list.length - a.list.length || a.file.localeCompare(b.file));
  }, [issues]);

  // Collapsed by default would hide the point of the panel; open by default with a
  // per-file toggle keeps a 40-file repository navigable without hiding a 2-file one.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (file: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
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
      <div className="mb-md flex items-center justify-between">
        <span className="text-meta uppercase tracking-wide text-[var(--text-secondary)]">Issues</span>
        <span className="tnum text-micro text-[var(--text-muted)]">
          {issues.length} in {groups.length} {groups.length === 1 ? "file" : "files"}
        </span>
      </div>

      <div className="space-y-2xs">
        {groups.map(({ file, list }) => {
          const isCollapsed = collapsed.has(file);
          const inThisFile = file === activePath;
          return (
            <div key={file}>
              <button
                type="button"
                onClick={() => toggle(file)}
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
                      <li key={issue.id}>
                        <button
                          type="button"
                          onClick={() => onOpenIssue(issue.file, issue.line)}
                          title={`${sev.label} · ${issue.title} — open ${issue.file}:${issue.line}`}
                          className="flex w-full min-w-0 cursor-pointer items-start gap-2xs rounded-sm px-2xs py-2xs text-left transition-colors duration-200 hover:bg-[var(--surface-hover)]"
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
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
