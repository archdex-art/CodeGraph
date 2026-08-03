"use client";

import { AlertTriangle, Check, Minus, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import type { GateResult, VerificationRecord } from "@codegraph/verify";

/**
 * The verification verdict, with `full` and `partial` rendered DISTINCTLY (PLAN.md §4).
 *
 * WHAT THIS REPLACES. The verdict banner was `res.verified ? emerald : amber` — one boolean,
 * two colours. A run where the repository's test suite never executed carries
 * `verified: true, level: "partial"`, and it rendered IDENTICALLY to a run where the suite ran
 * and passed. Same green, same shield, same "verified".
 *
 * That is review item C3 reappearing one layer up. C3 was about the executor computing
 * `verified` from the score it was built to move; the four gates fixed the computation. But a
 * correct `partial` displayed as if it were `full` re-tells the same lie at the last possible
 * moment, and the hosted demo is where it would be told: SPIKES.md §2 records that Render
 * grants no privileged containers, so gate 3 CANNOT run there. The demo most people see is
 * structurally incapable of full verification.
 *
 * So the distinction is not a nicety. Under the old banner, the deployment that can never run
 * a test suite showed the same green badge as a developer's own machine that did.
 *
 * `partial` is therefore deliberately NOT green. It is not a failure — nothing regressed, the
 * gates that could run passed — but "we could not run your tests" must not look like success.
 * Gates are always listed, including skips and their reasons, because "which check did not
 * happen, and why" is the only thing that makes a partial verdict actionable.
 */

const LEVEL = {
  full: {
    Icon: ShieldCheck,
    ring: "border-[var(--accent-text)]/20 bg-[var(--accent-text)]/[0.06]",
    fg: "text-[var(--accent-text)]",
    label: "Verified",
    // Named for what actually happened, not for a grade. "Verified" alone is what let a
    // partial run pass as a full one.
    detail: "your test suite ran and passed",
  },
  partial: {
    Icon: ShieldQuestion,
    ring: "border-sky-500/25 bg-sky-500/[0.06]",
    fg: "text-sky-400",
    label: "Partially verified",
    detail: "checks passed, but your test suite did not run here",
  },
  none: {
    Icon: AlertTriangle,
    ring: "border-[var(--amber-text)]/20 bg-[var(--amber-text)]/[0.06]",
    fg: "text-[var(--amber-text)]",
    label: "Not verified",
    detail: "no verification gate completed",
  },
  // Distinct from `none`. Caught by looking at the rendered output: a record with a FAILED
  // gate was reading "no verification gate completed", which is the opposite of what
  // happened — a gate ran and rejected the patch. Conflating "nothing ran" with "something
  // failed" is the precise imprecision this component exists to remove.
  failed: {
    Icon: AlertTriangle,
    ring: "border-[var(--coral-text)]/25 bg-[var(--coral-text)]/[0.06]",
    fg: "text-[var(--coral-text)]",
    label: "Verification failed",
    detail: "a gate rejected this patch",
  },
} as const;

const GATE_LABEL: Record<GateResult["gate"], string> = {
  syntax: "Syntax",
  types: "Types",
  tests: "Your tests",
  reanalysis: "Finding gone",
};

const STATUS = {
  passed: { Icon: Check, fg: "text-[var(--accent-text)]", border: "border-[var(--accent-text)]/25" },
  failed: { Icon: X, fg: "text-[var(--coral-text)]", border: "border-[var(--coral-text)]/30" },
  skipped: { Icon: Minus, fg: "text-[var(--text-muted)]", border: "border-[var(--line)]" },
} as const;

/**
 * Which verdict a record earns. Exported and pure because this is the LOGIC — "is a failed
 * gate still partial?" is a judgement, not markup, and it is the part that can be wrong in a
 * way users see. The component below only paints what this returns.
 */
export function verdictFor(record?: VerificationRecord): keyof typeof LEVEL {
  if (!record) return "none";
  // A failed gate outranks the level, and gets its OWN verdict. `level` describes how much of
  // the suite COULD run, so a record can read `partial` while a gate actively failed. Painting
  // that as the benign "we could not run everything" case would be the same overclaim one
  // layer down; calling it "not verified" would misreport it in the other direction.
  if (record.gates.some((g) => g.status === "failed")) return "failed";
  return record.level;
}

export function VerificationVerdict({
  record,
  message,
  scoreBefore,
  scoreAfter,
  showScores,
}: {
  /** Absent on paths that never ran verification — then there is no verdict to show. */
  record?: VerificationRecord;
  message: string;
  scoreBefore: number;
  scoreAfter: number;
  showScores: boolean;
}) {
  const level = verdictFor(record);
  const { Icon, ring, fg, label, detail } = LEVEL[level];

  return (
    <div className={`rounded-lg border p-md ${ring}`} data-testid="verification-verdict" data-level={level}>
      <div className="flex items-center gap-md">
        <Icon className={`w-5 h-5 shrink-0 ${fg}`} aria-hidden />
        <div className="min-w-0">
          <div className={`text-meta font-semibold ${fg}`}>
            {label}
            <span className="font-normal text-[var(--text-secondary)]"> — {detail}</span>
          </div>
          <div className="text-meta text-[var(--text-secondary)] mt-2xs break-words">{message}</div>
        </div>
        {showScores && (
          <div className="ml-auto flex items-center gap-sm text-meta shrink-0">
            <span className="text-[var(--text-secondary)]">{scoreBefore}</span>
            <span className="text-[var(--text-muted)]">→</span>
            <span className={`font-bold ${fg}`}>{scoreAfter}</span>
          </div>
        )}
      </div>

      {record && record.gates.length > 0 && (
        <div className="mt-md flex flex-wrap gap-xs">
          {record.gates.map((g) => {
            const s = STATUS[g.status];
            return (
              <span
                key={g.gate}
                data-testid={`gate-${g.gate}`}
                data-status={g.status}
                title={g.reason ?? `${g.status} in ${g.ms}ms`}
                className={`inline-flex items-center gap-2xs rounded-xs border px-xs py-hair text-micro ${s.border} ${s.fg}`}
              >
                <s.Icon className="w-3 h-3" aria-hidden />
                {GATE_LABEL[g.gate]}
                {/* The reason is the actionable half of a skip — surface it, don't hide it in
                    a tooltip only. */}
                {g.status === "skipped" && g.reason && (
                  <span className="text-[var(--text-muted)]">· {g.reason}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
