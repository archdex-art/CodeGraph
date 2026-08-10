import type { RepoDrift } from "./types";

/**
 * Ranking a list of repositories by how much they MOVED.
 *
 * Lives here, and not in either page, because two pages rank the same estate: the fleet
 * index and the dashboard's ranked table. When one of them sorted by mean health and the
 * other by insertion order, a repository could be first on one page and eighth on the
 * other with no visible reason, and the user's only way to reconcile them was to read
 * both. One comparator, imported twice, is what makes that impossible rather than merely
 * unlikely.
 *
 * Pure and free of any React or fetch dependency, so the ordering is testable as
 * arithmetic — which is the only way to pin down a rule with this many edge cases
 * (unindexed, indexed once, failed, unchanged) without driving a browser.
 */

/**
 * Ordering classes, most urgent first. Compared before magnitude, because these are
 * different KINDS of row and interleaving them by a number would be comparing things
 * that are not comparable.
 *
 * `first` sits above `unmeasured` and `steady`: a repository indexed once is the one row
 * where the reader learns something by looking (there is a report, and nobody has seen a
 * second one yet), while an unchanged repo is the definition of "nothing to do here".
 */
export const DRIFT_TIER = {
  failed: 0,
  moved: 1,
  first: 2,
  unmeasured: 3,
  steady: 4,
} as const;

export type DriftTier = (typeof DRIFT_TIER)[keyof typeof DRIFT_TIER];

/** The minimum a row needs to be ranked. Both pages' row types satisfy it structurally. */
export interface DriftRow {
  readonly id: string;
  readonly name: string;
  readonly drift?: RepoDrift | null;
}

export function driftTier(drift: RepoDrift | null | undefined): DriftTier {
  if (!drift) return DRIFT_TIER.unmeasured;
  if (drift.failed) return DRIFT_TIER.failed;
  // Null deltas mean there was no previous run to subtract — a first index, which is
  // reported as such and never as a zero.
  if (drift.scoreDelta === null && drift.findingsDelta === null) return DRIFT_TIER.first;
  return driftMagnitude(drift) === 0 ? DRIFT_TIER.steady : DRIFT_TIER.moved;
}

/**
 * How far a repository moved, in units of "things the reader has to account for".
 *
 * Score points and findings are added, unweighted, and that is a decision rather than an
 * oversight. The score is already a bounded 0–100 summary, so its deltas are naturally
 * small; findings are the raw count the score is computed FROM. A repo that gained 40
 * findings while its score held (a large codebase absorbing them) genuinely is the bigger
 * mover of the two, and any weighting that suppressed it would be a hand-picked constant
 * of exactly the kind ADR-009 deleted from the scoring model.
 */
export function driftMagnitude(drift: RepoDrift | null | undefined): number {
  if (!drift) return 0;
  return Math.abs(drift.scoreDelta ?? 0) + Math.abs(drift.findingsDelta ?? 0);
}

/** Did it move the WRONG way? Score down or findings up. */
export function driftRegressed(drift: RepoDrift | null | undefined): boolean {
  if (!drift) return false;
  return (drift.scoreDelta ?? 0) < 0 || (drift.findingsDelta ?? 0) > 0;
}

/**
 * Total order: tier, then magnitude descending, then regressions ahead of improvements of
 * equal size, then name.
 *
 * The name tie-break is not cosmetic. Both pages poll on an interval and re-sort on every
 * response, so a comparator that returned 0 for two equal rows would let them swap places
 * under a re-render and produce a list that twitches while nothing has changed.
 */
export function compareDrift(a: DriftRow, b: DriftRow): number {
  const tier = driftTier(a.drift) - driftTier(b.drift);
  if (tier !== 0) return tier;

  const magnitude = driftMagnitude(b.drift) - driftMagnitude(a.drift);
  if (magnitude !== 0) return magnitude;

  const regressed = Number(driftRegressed(b.drift)) - Number(driftRegressed(a.drift));
  if (regressed !== 0) return regressed;

  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function rankByDrift<T extends DriftRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareDrift);
}

/**
 * The reading, as words.
 *
 * Signs are explicit on both numbers because the two move in opposite senses: `+4 score`
 * is good news and `+4 findings` is bad news, and a bare pair of numbers would leave the
 * reader to remember which column meant which.
 */
export function driftLabel(drift: RepoDrift | null | undefined): string {
  if (!drift) return "not indexed";
  if (drift.failed) return "index failed";
  if (drift.scoreDelta === null && drift.findingsDelta === null) return "first index";

  const parts: string[] = [];
  if (drift.scoreDelta) parts.push(`${signed(drift.scoreDelta)} score`);
  if (drift.findingsDelta) parts.push(`${signed(drift.findingsDelta)} findings`);
  return parts.length ? parts.join(" · ") : "no change";
}

/** U+2212, not a hyphen: a hyphen at this size reads as a dash in the tabular numerals. */
function signed(n: number): string {
  return n < 0 ? `\u2212${Math.abs(n)}` : `+${n}`;
}

/**
 * Colour token for a drift reading. Coral for a regression, signal for an improvement,
 * muted for everything that did not move — the same three meaning-bound accents the rest
 * of the app uses, never a fourth.
 */
export function driftTone(drift: RepoDrift | null | undefined): string {
  if (drift?.failed || driftRegressed(drift)) return "text-[var(--coral-text)]";
  if (driftMagnitude(drift) > 0) return "text-[var(--accent-text)]";
  return "text-[var(--text-muted)]";
}
