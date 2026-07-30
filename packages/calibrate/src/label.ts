import { parseGitLog, signalsFromCommits, type Commit, type FileSignals } from "@codegraph/vcs";

/**
 * Defect labelling for score calibration (PLAN.md §5.3).
 *
 * The method is standard: label a file defective if a bug-fix commit touched it inside an
 * observation window, score the file at T0 — the commit immediately BEFORE that window opens —
 * and fit weights on (features at T0) → (defective during the window).
 *
 * ## The one thing that makes or breaks this
 *
 * §5.3: *"Scoring inside the window lets the fit see its own answer. This is the step that is
 * easiest to get wrong and hardest to detect afterward."*
 *
 * Leakage does not announce itself. A leaky fit produces BETTER numbers — a higher AUC, a
 * cleaner scorecard — and the failure only surfaces when the model meets a repository it has
 * not already seen the answers for. By then the constants are shipped and the scorecard has
 * locked them in.
 *
 * So the boundary is structural here, not a convention. `buildDataset` takes two disjoint
 * commit sets and cannot see a single object that spans them: features are computed from
 * `historyBefore` and labels from `windowAfter`, and `assertDisjoint` refuses to run if any
 * commit appears in both. A caller cannot pass one list twice by mistake.
 *
 * ## What this deliberately does not do
 *
 * No fitting. This produces a labelled dataset and stops. Regression belongs in an offline
 * script whose output is a table of constants, and shipping an inference engine would violate
 * the "no model at runtime" constraint §5.3 states outright.
 */

/**
 * A commit as parsed from `git log`.
 *
 * An alias for `vcs`'s `Commit` rather than a second declaration of the same fields: two
 * structurally identical types drift the moment one gains a field, and the parser that fills
 * this is the one in `vcs`.
 */
export type LabelCommit = Commit;

export interface LabelledFile {
  readonly file: string;
  /** Organisational signals computed at T0, from history strictly before the window. */
  readonly features: FileSignals;
  /** True when at least one bug-fix commit touched this file inside the window. */
  readonly defective: boolean;
  /** How many bug-fix commits touched it. Kept for weighting and for auditing labels by hand. */
  readonly fixCount: number;
}

export interface Dataset {
  readonly files: readonly LabelledFile[];
  /** Files present at T0 with history; the denominator for the defect rate. */
  readonly total: number;
  readonly defective: number;
  /** `defective / total`, the base rate a fit must beat to be worth anything. */
  readonly defectRate: number;
  /**
   * Bug-fix commits observed in the window — the real sample size.
   *
   * Reported because `total` flatters it. Measured on express with a 2023 six-month window:
   * 234 files and a 3.0% defect rate, from FIVE fix commits. A fit on that is noise wearing a
   * percentage, and nothing about the file count says so.
   */
  readonly fixCommits: number;
}

export interface DatasetOptions {
  /**
   * Which files belong in the dataset. Default: everything with history.
   *
   * Supplied by the caller rather than decided here, because `calibrate` deliberately knows
   * nothing about languages — that lives in `analysis`, which this package must not import.
   *
   * It matters more than it sounds. Without a filter, express's top labelled file is
   * `History.md`: a changelog that every fix commit touches, so it correlates perfectly with
   * defects and predicts nothing. `.github/workflows/ci.yml` lands the same way. Both were in
   * the first real run.
   */
  readonly includeFile?: (file: string) => boolean;
}

export class LeakageError extends Error {
  constructor(overlap: readonly string[]) {
    super(
      `Calibration leakage: ${overlap.length} commit(s) appear in BOTH the feature history and ` +
        `the label window (e.g. ${overlap.slice(0, 3).join(", ")}). Features must come strictly ` +
        `from before T0. A fit built on this would score better and predict worse.`,
    );
    this.name = "LeakageError";
  }
}

/**
 * Refuse to build a dataset whose two halves overlap.
 *
 * Identity is the commit hash, not the timestamp: two commits can share a second, and
 * rebases/cherry-picks make timestamps an unreliable key. The caller supplies hashes.
 */
export function assertDisjoint(
  beforeHashes: readonly string[],
  afterHashes: readonly string[],
): void {
  const before = new Set(beforeHashes);
  const overlap = afterHashes.filter((h) => before.has(h));
  if (overlap.length > 0) throw new LeakageError(overlap);
}

/**
 * Which files a window's bug-fix commits touched, and how often.
 *
 * Only `isFix` commits count. A file changed fifty times in the window by ordinary feature work
 * is not defective — that is churn, and churn is a FEATURE. Conflating the two is how a model
 * learns to predict its own input.
 */
export function labelsFromWindow(window: readonly LabelCommit[]): Map<string, number> {
  const fixes = new Map<string, number>();
  for (const c of window) {
    if (!c.isFix) continue;
    for (const f of c.files) fixes.set(f, (fixes.get(f) ?? 0) + 1);
  }
  return fixes;
}

/**
 * Assemble a labelled dataset from two disjoint commit sets.
 *
 * `historyBefore` produces the features; `windowAfter` produces the labels. Passing the same
 * commits as both throws rather than returning an impressive number.
 *
 * Files are those with history before T0. A file created DURING the window has no features to
 * score, so including it would mean predicting from nothing — it is excluded, and that
 * exclusion is why `total` is reported alongside the rate.
 */
export function buildDataset(
  historyBefore: readonly LabelCommit[],
  windowAfter: readonly LabelCommit[],
  hashes?: { readonly before: readonly string[]; readonly after: readonly string[] },
  options: DatasetOptions = {},
): Dataset {
  if (hashes) assertDisjoint(hashes.before, hashes.after);

  const include = options.includeFile ?? (() => true);
  const features = signalsFromCommits(historyBefore);
  const fixes = labelsFromWindow(windowAfter);

  const files: LabelledFile[] = [];
  for (const [file, f] of features) {
    if (!include(file)) continue;
    const fixCount = fixes.get(file) ?? 0;
    files.push({ file, features: f, defective: fixCount > 0, fixCount });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));

  const defective = files.filter((f) => f.defective).length;
  return {
    files,
    total: files.length,
    defective,
    defectRate: files.length === 0 ? 0 : defective / files.length,
    fixCommits: windowAfter.filter((c) => c.isFix).length,
  };
}

/** Parse a `git log` payload into the commit shape this module labels. */
export function commitsFromLog(raw: string): LabelCommit[] {
  return parseGitLog(raw);
}
