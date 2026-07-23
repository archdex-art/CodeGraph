import type { Dimension, DimensionScore, Issue } from "../types";
import { DIMENSION_META } from "../types";

/**
 * Score model (per design doc 07):
 *   penalty = Σ severity × blastRadius   (recency/confidence = 1 here)
 *   sub_score = 100 × exp(-k · penalty / sizeFactor)
 * Larger codebases tolerate more raw penalty (normalized by LOC).
 */
export function score(issues: Issue[], loc: number): { dimensions: DimensionScore[]; overall: number } {
  const sizeFactor = Math.max(1, Math.log10(Math.max(loc, 10)) ** 2); // ~1 small → ~10 huge
  const k = 0.06;

  const dims: DimensionScore[] = (Object.keys(DIMENSION_META) as Dimension[]).map((dim) => {
    const di = issues.filter((i) => i.dimension === dim);
    const penalty = di.reduce((s, i) => s + i.severity * i.blastRadius, 0);
    const norm = penalty / sizeFactor;
    const sub = 100 * Math.exp(-k * norm);
    return {
      dimension: dim,
      score: Math.round(Math.max(0, Math.min(100, sub))),
      penalty: Math.round(penalty * 10) / 10,
      issueCount: di.length,
    };
  });

  const overall = dims.reduce((s, d) => s + d.score * DIMENSION_META[d.dimension].weight, 0);
  return { dimensions: dims, overall: Math.round(overall) };
}
