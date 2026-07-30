/**
 * Ranking metrics for calibration (PLAN.md §5.3).
 *
 * Hand-rolled rather than pulled from a library: this repository ships no ML dependency and
 * §5.3 explicitly wants "the learned constants only — no model, no inference at runtime". A
 * scoring library in `package.json` is a standing invitation to import it from the product.
 *
 * Every function here is pure and deterministic. Nothing samples without an explicit seed.
 */

/**
 * Area under the ROC curve, by the Mann-Whitney U identity.
 *
 * AUC equals the probability that a randomly chosen positive outranks a randomly chosen
 * negative, which is exactly U / (n_pos · n_neg). Computed from RANKS rather than by sweeping
 * a threshold, because the rank form handles TIES correctly — and ties are the common case
 * here: `priorDefect` is 0 for most files, and a threshold sweep would silently award that
 * baseline either 1.0 or 0.0 depending on sort order.
 *
 * Returns null when one class is absent. An AUC over a single class is undefined, and
 * returning 0.5 for it would look like a result.
 */
export function auc(scores: readonly number[], labels: readonly boolean[]): number | null {
  if (scores.length !== labels.length) {
    throw new Error(`auc: ${scores.length} scores vs ${labels.length} labels`);
  }
  const pos = labels.filter(Boolean).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return null;

  // Midranks, so tied scores share the average of the ranks they span.
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const rank = new Array<number>(scores.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.s === order[i]!.s) j++;
    const mid = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) rank[order[k]!.i] = mid;
    i = j + 1;
  }

  let rankSumPos = 0;
  for (let k = 0; k < labels.length; k++) if (labels[k]) rankSumPos += rank[k]!;
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Deterministic PRNG. A bootstrap that cannot be reproduced is not evidence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Percentile bootstrap CI for a cross-project AUC, resampling REPOSITORIES rather than rows.
 *
 * The unit of independence is the repository, not the file. Files inside one repo share a
 * codebase, a team, and a review process, so resampling rows treats 400 eslint files as 400
 * independent observations and returns an interval far too narrow — the classic way a
 * cross-project claim gets a confidence interval it has not earned.
 */
export function bootstrapAucByRepo(
  groups: ReadonlyArray<{ scores: readonly number[]; labels: readonly boolean[] }>,
  opts: { iterations?: number; seed?: number; alpha?: number } = {},
): Interval | null {
  const iterations = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 42);
  const usable = groups.filter((g) => g.labels.some(Boolean) && g.labels.some((l) => !l));
  if (usable.length < 2) return null;

  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const scores: number[] = [];
    const labels: boolean[] = [];
    for (let k = 0; k < usable.length; k++) {
      const g = usable[Math.floor(rand() * usable.length)]!;
      scores.push(...g.scores);
      labels.push(...g.labels);
    }
    const a = auc(scores, labels);
    if (a !== null) samples.push(a);
  }
  if (samples.length === 0) return null;
  samples.sort((x, y) => x - y);
  const at = (p: number) =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * samples.length)))]!;
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2) };
}
