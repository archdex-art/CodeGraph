import type { FindingId, RunId, SymbolId } from "./ids";

/** Repo-relative, posix-separated source location. 1-indexed (LLD §2). */
export interface SourceRange {
  readonly file: string;
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

export type Severity = 1 | 2 | 3 | 4 | 5;

/**
 * `performance` is present here but absent from v1's `Dimension` in
 * apps/web/src/lib/types.ts. The two are deliberately NOT unified in P1:
 * adding a dimension changes the Health Score's weighting and therefore the
 * number users see, which is a behaviour change. P3 reconciles them.
 */
export type Dimension =
  | "security"
  | "correctness"
  | "maintainability"
  | "test_integrity"
  | "dependency_hygiene"
  | "performance";

export interface DataflowStep {
  readonly range: SourceRange;
  /** Human-readable, rendered verbatim. e.g. "source: req.body.name". */
  readonly label: string;
  readonly symbol: SymbolId | null;
}

export interface Evidence {
  /** Verbatim source of the offending range, trimmed. Never reconstructed. */
  readonly snippet: string;
  /** Why the engine believes this. Rendered in the UI verbatim. */
  readonly rationale: string;
  /** Ordered source→sink trace, present only for dataflow rules. */
  readonly dataflow?: readonly DataflowStep[];
}

/**
 * How much the engine's belief rests on. Ordered weakest → strongest; this is
 * the axis the UI uses to decide whether a finding may be shown as certain.
 */
export type ConfidenceBasis =
  | "syntactic"
  | "structural"
  | "type_verified"
  | "dataflow_verified"
  | "corroborated";

/** Analysis depth actually achieved for a file (HLD §8.3). */
export type AnalysisTier = "full" | "ast" | "lexical" | "skipped";

/**
 * Ordering over tiers, for "at least AST-quality" style comparisons.
 * Deliberately a function over a frozen map rather than a numeric enum: the
 * wire/DB representation of a tier stays the string, so a persisted run never
 * depends on the ordinal.
 */
const TIER_RANK: Readonly<Record<AnalysisTier, number>> = Object.freeze({
  skipped: 0,
  lexical: 1,
  ast: 2,
  full: 3,
});

export function tierRank(tier: AnalysisTier): number {
  return TIER_RANK[tier];
}

export type FindingStatus = "open" | "fixed" | "dismissed" | "suppressed";

export interface Finding {
  readonly id: FindingId;
  readonly runId: RunId;
  /** Namespaced, stable, machine-readable. e.g. "js/sql-injection". */
  readonly ruleId: string;
  readonly range: SourceRange;
  readonly symbol: SymbolId | null;
  readonly severity: Severity;
  /** 0..1. */
  readonly confidence: number;
  readonly confidenceBasis: ConfidenceBasis;
  readonly dimension: Dimension;
  readonly title: string;
  readonly evidence: Evidence;
  /** Symbol-level reachable callers, not file fan-in (fixes review B2). */
  readonly blastRadius: number;
  readonly churn: number;
  /** Tier of the file this came from, so a low-tier finding can be labelled. */
  readonly analysisTier: AnalysisTier;
  /** Location-independent identity. Survives file moves and line shifts. */
  readonly fingerprint: string;
  readonly status: FindingStatus;
}
