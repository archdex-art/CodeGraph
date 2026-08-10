"use client";

import type { Issue } from "@/lib/types";
import { findingKey, ignoreComment, ruleIdOf } from "@/lib/findings";
import { CopyButton } from "./CopyButton";

/**
 * What turns a claim into a checkable claim.
 *
 * A finding that says "Possible hardcoded secret" and nothing else asks the reader to
 * go and reconstruct the detector's reasoning from the file. The evidence line is that
 * reasoning, already written down: the matched text, the count that tripped a threshold,
 * the taint verdict. It is the difference between a list you audit and a list you skip.
 *
 * The rule id is next to it because it is the thing you act on when the finding is
 * wrong — it is the token an ignore comment and a baseline entry are both keyed by, and
 * both are one click away here rather than something to look up in the docs.
 */
export function FindingEvidence({
  issue,
  compact = false,
  className = "",
}: {
  issue: Issue;
  /** The editor rail is one rail wide: labels shrink, the actions stay. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      {issue.evidence ? (
        <p className="mt-2xs max-w-note text-micro text-[var(--text-secondary)] [overflow-wrap:anywhere]">
          {issue.evidence}
        </p>
      ) : (
        <p className="mt-2xs text-micro text-[var(--text-faint)]">
          No evidence recorded — re-index to capture what the detector matched.
        </p>
      )}
      <div className="mt-2xs flex flex-wrap items-center gap-2xs">
        <code
          title={`Rule ${ruleIdOf(issue)}`}
          className="rounded-xs border border-[var(--line)] bg-[var(--surface-3)] px-2xs py-hair font-mono text-micro text-[var(--text-muted)] [overflow-wrap:anywhere]"
        >
          {ruleIdOf(issue)}
        </code>
        <CopyButton
          value={ignoreComment(issue)}
          label={compact ? "ignore" : "Copy ignore comment"}
          title={`Copy "${ignoreComment(issue)}" — replace the reason before you commit it`}
        />
        <CopyButton
          value={findingKey(issue)}
          label={compact ? "key" : "Copy baseline key"}
          title={`Copy "${findingKey(issue)}" for .codegraph-baseline.json`}
        />
      </div>
    </div>
  );
}
