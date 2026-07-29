import type { AnalysisTier, Dimension } from "./finding.js";
import type { RepoId, RunId } from "./ids.js";

/**
 * What the analysis actually managed to look at (HLD §8.3, ADR-008).
 *
 * This is published next to the Health Score rather than hidden, because a
 * score computed over 40% of a repo and one computed over 100% are different
 * claims, and a single number that does not disclose its coverage invites the
 * reader to assume the second.
 */
export interface AnalysisCoverage {
  readonly totalFiles: number;
  readonly byTier: Readonly<Record<AnalysisTier, number>>;
  readonly locAtAstOrBetter: number;
  readonly totalLoc: number;
  /** locAtAstOrBetter / totalLoc. 0..1. */
  readonly ratio: number;
}

export interface StageTiming {
  readonly stage: string;
  readonly ms: number;
  readonly ok: boolean;
  /**
   * Set when the stage completed but gave up something, e.g.
   * "parse budget exhausted at 3412/8900 files". A stage that exceeds its
   * budget degrades and records it here; it does not throw (HLD §8.1), so the
   * UI can report partial analysis instead of a silently wrong score.
   */
  readonly degraded?: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * The unit of immutability (HLD §7). A repo does not "have a score" — a *run*
 * has a score. That is what makes Timeline natural rather than bolted on, score
 * deltas well-defined, and two runs comparable without re-analysis.
 */
export interface AnalysisRun {
  readonly id: RunId;
  readonly repoId: RepoId;
  readonly commitSha: string | null;
  readonly engineVersion: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: RunStatus;
  readonly coverage: AnalysisCoverage;
  readonly timings: readonly StageTiming[];
}

export interface DimensionScore {
  readonly dimension: Dimension;
  /** 0..100. */
  readonly score: number;
  /** Raw accumulated penalty mass, before projection to 0..100. */
  readonly penalty: number;
  readonly findingCount: number;
}
