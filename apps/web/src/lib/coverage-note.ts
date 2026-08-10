import { plural } from "./plural";
import type { ScanCoverage } from "./types";

/**
 * The sentence the report puts next to the Health Score, saying what the score was actually
 * computed over (ADR-008).
 *
 * WHY THIS IS A FUNCTION AND NOT JSX
 *
 * It was six nested spans inside `app/repos/[id]/page.tsx`, which meant the one piece of copy
 * whose job is to stop the score overclaiming was the one piece nothing could assert on: the
 * suite runs vitest in the `node` environment with no DOM, so nothing can render a component.
 * A pure string is testable, and it is now also reusable — the dashboard ranks repositories by
 * score and needs the same disclosure.
 *
 * WHY THE CAPPED CASE DROPS THE PERCENTAGE
 *
 * `filesSeen` is what the walk ENCOUNTERED, and when `capHit` is true the walk broke out with
 * directories still on its stack — so `filesSeen` is not the repository's file count and
 * `filesAnalysed / filesSeen` is not a fraction of the repository. Measured: `microsoft/TypeScript`
 * holds 39,334 analysable source files and the default `CG_MAX_FILES=4000` scores ~10% of it,
 * which the old sentence rendered as a confident "Scored over 97% of files". A percentage over
 * a truncated denominator is a bigger lie than no percentage, and the real total is genuinely
 * unknown — the walk never went and looked — so the capped sentence reports counts and says
 * where they stop instead of inventing a total to divide by.
 */
export interface CoverageNote {
  /** What the score was computed over. Always a complete sentence. */
  readonly scope: string;
  /**
   * The truncation disclosure, or null when the walk finished the repository.
   *
   * Separate from `scope` so the caller can give it the amber treatment the rest of the
   * sentence does not get — this is the part that changes what the score MEANS.
   */
  readonly sample: string | null;
}

const n = (v: number): string => v.toLocaleString();

export function coverageNote(coverage: ScanCoverage): CoverageNote {
  const extras: string[] = [];
  if (coverage.skippedTooLarge > 0) extras.push(`${n(coverage.skippedTooLarge)} over the size cap`);
  if (coverage.skippedNoLanguage > 0) extras.push(`${n(coverage.skippedNoLanguage)} unsupported`);

  if (coverage.capHit) {
    const parenthetical = extras.length > 0 ? ` (${extras.join(", ")})` : "";
    // `unvisitedDirs` bounds what was left rather than guessing what was in it, so it is named
    // when there is one and omitted rather than printed as a zero when the cap landed on the
    // last directory.
    const left =
      coverage.unvisitedDirs > 0
        ? ` with ${plural(coverage.unvisitedDirs, "directory", "directories")} left unvisited`
        : "";
    return {
      scope: `Scored over ${n(coverage.filesAnalysed)} of the ${plural(
        coverage.filesSeen,
        "file",
      )} the walk reached${parenthetical}.`,
      // Names `CG_MAX_FILES` because the cap is the one thing in this sentence a self-hoster
      // can move, and a disclosure you cannot act on is just an apology.
      sample: `The walk stopped at the CG_MAX_FILES cap${left}, so this is a sample of the repository, not all of it.`,
    };
  }

  const inner = [`${n(coverage.filesAnalysed)} of ${n(coverage.filesSeen)}`, ...extras].join(", ");
  const pct =
    coverage.filesSeen === 0
      ? "—"
      : `${Math.round((coverage.filesAnalysed / coverage.filesSeen) * 100)}%`;
  return { scope: `Scored over ${pct} of files (${inner}).`, sample: null };
}
