import { execSync } from "node:child_process";

/**
 * Organisational signals from ONE `git log` pass (PLAN.md §5.2).
 *
 * The published defect-prediction literature consistently finds git/organisational markers
 * among the strongest predictors of where bugs land — above static complexity. The scorer had
 * churn and nothing else, which is the weakest of them.
 *
 * WHAT THESE ARE NOT, and this is the important part: they are MEASUREMENTS, not score inputs.
 * Nothing here is wired into the Health Score, because assigning each of these a weight by hand
 * would add eight more hand-picked constants to a model whose whole problem (PLAN.md §5) is
 * that its one constant was hand-picked. §5.3 fits the weights against a labelled defect corpus
 * and ships the learned constants; until that exists these are reported facts and features
 * waiting for a fit.
 *
 * ONE PASS. Every signal below is derived from a single `git log` invocation, because a second
 * pass over a large repository costs seconds and the whole point is that these are cheap.
 *
 * KNOWN LIMITS, stated rather than discovered later:
 *   · `--name-only` does not follow renames, so a renamed file starts a fresh history. Git's
 *     rename detection is a similarity heuristic, and threading it through would make every
 *     signal depend on that heuristic's threshold.
 *   · Authors are identified by name. One human with two `user.name` spellings reads as two
 *     developers, which inflates congestion and deflates ownership. Mailmap would help and is
 *     not applied.
 *   · Merge commits contribute nothing: `--name-only` emits no file list for a merge unless
 *     asked, so they neither inflate churn nor register as co-changes. Verified on this
 *     repository — 4851 file-lines with and without `--no-merges`.
 */

/** Field/record separators that cannot appear in a git author name or subject line. */
const RS = "\x1e";
const US = "\x1f";

/**
 * A commit touching more files than this contributes to churn but NOT to co-change coupling.
 *
 * A 400-file commit is a rename, a reformat, or a dependency bump. Treating it as evidence
 * that those 400 files are coupled is both wrong and quadratically expensive — the pair count
 * for one such commit exceeds the pair count for a thousand real ones.
 */
const CO_CHANGE_MAX_FILES = 50;

/**
 * Conventional-commit types that are definitively NOT bug fixes.
 *
 * When a subject carries a type prefix, the type is authoritative and keyword matching is
 * skipped entirely. `deps: bump qs minimum to 6.15.2 (#7305)` is a dependency bump whatever
 * words follow it — and on express, `deps:` alone is 480 commits.
 */
const NON_FIX_TYPES = new Set([
  "feat", "feature", "docs", "doc", "test", "tests", "chore", "build", "ci", "style",
  "refactor", "perf", "deps", "dep", "release", "examples", "example", "lint", "bench",
]);

/** Conventional-commit types that ARE bug fixes. */
const FIX_TYPES = new Set(["fix", "bugfix", "hotfix", "revert"]);

/** `type:` or `type(scope):` or `type(scope)!:` at the start of a subject. */
const CONVENTIONAL_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:/;

/**
 * Fix keywords for subjects with no conventional prefix.
 *
 * A BARE `#\d+` IS NOT HERE, and removing it was the single biggest correctness fix in this
 * file. GitHub squash-merges append `(#123)` to every commit, so matching it flagged features,
 * docs, and dependency bumps as defects. Measured on express: of 1140 commits the old pattern
 * called fixes, 282 (24.7%) matched ONLY on `#\d+` — `feat: allow conditional revalidation
 * (#7366)`, `docs: use the new logo (#7316)`, `build(deps): bump actions/checkout (#7345)`.
 * An issue reference means a commit is linked to a discussion, not that it repairs anything.
 *
 * An issue number still counts when a CLOSING VERB precedes it, which is the GitHub convention
 * that actually carries meaning.
 */
const FIX_WORD_RE =
  /\b(bug ?fix|hot ?fix|fix(e[sd])?|repair(e[sd])?|correct(e[sd])?|revert(e[sd])?)\b/i;
/**
 * `fixes #12` only — NOT `closes #12` or `resolves #12`.
 *
 * GitHub's closing keywords shut an issue of ANY kind, including feature requests. The
 * hand-audit caught three false positives in twenty from exactly this: `Added
 * \`app.routes.all()\`. Closes #803`, `Refactored router. Closes #639`, and `Updated
 * express(1). Closes #365` — a feature, a refactor and a chore, all labelled defects because
 * they closed a ticket. Only the "fix" verb says what the commit DID.
 */
const CLOSES_ISSUE_RE = /\bfix(e[sd])?\s+#\d+/i;

/**
 * Automated authors, excluded from BOTH features and labels.
 *
 * A dependabot commit is not a developer touching a file. Counting it inflates `authors`,
 * `busFactor` and `changeEntropy` — the very signals meant to measure how many humans are
 * involved — and its subjects are the largest single source of false fix labels.
 */
const BOT_AUTHOR_RE =
  /\[bot\]$|^(dependabot|renovate|greenkeeper|snyk-bot|github-actions|semantic-release-bot)\b/i;

export function isBotAuthor(author: string): boolean {
  return BOT_AUTHOR_RE.test(author.trim());
}

/**
 * Whether a commit subject describes a bug fix.
 *
 * Exported so the labelling harness and any hand-audit use the SAME classifier — a second
 * implementation is a second definition of "defect", and the corpus would be labelled by one
 * while the features were built by the other.
 */
export function isFixSubject(subject: string): boolean {
  const conventional = CONVENTIONAL_RE.exec(subject.trim());
  if (conventional) {
    const type = conventional[1]!.toLowerCase();
    if (FIX_TYPES.has(type)) return true;
    // An explicit non-fix type is authoritative: no keyword rescue.
    if (NON_FIX_TYPES.has(type)) return false;
    // Unknown type — fall through to keywords.
  }
  return FIX_WORD_RE.test(subject) || CLOSES_ISSUE_RE.test(subject);
}

export interface FileSignals {
  /** Commits touching this file in the window. The pre-existing `churn`. */
  churn: number;
  /** Distinct authors — "developer congestion". */
  authors: number;
  /** The top author's share of this file's edits, 0..1. LOW means many hands. */
  ownershipRatio: number;
  /** Fewest authors accounting for >= 50% of edits. 1 means one person holds it. */
  busFactor: number;
  /** Distinct OTHER files this one has changed alongside. High means entangled. */
  coChangeScatter: number;
  /** Shannon entropy of the author distribution, normalised 0..1. */
  changeEntropy: number;
  /** Share of edits, 0..1, by authors with no commit in the most recent third of the window. */
  knowledgeLoss: number;
  /** Commits touching this file whose message looks like a fix. */
  priorDefect: number;
  /**
   * How unevenly this file's changes are spread over the window, 0..1.
   *
   * 0 is perfectly regular, approaching 1 is one burst. Computed as the normalised coefficient
   * of variation of the gaps between consecutive changes, so a file rewritten in a single day
   * a month ago reads differently from one edited steadily throughout.
   */
  ageVolatility: number;
}

/**
 * One commit, as parsed from `git log`.
 *
 * Exported and `readonly` so `@codegraph/calibrate` can hold the same shape without a cast.
 * Readonly is the honest signature anyway: `signalsFromCommits` only reads.
 */
export interface Commit {
  readonly author: string;
  readonly at: number;
  readonly isFix: boolean;
  readonly files: readonly string[];
}

/** Parse one `git log` payload into commits. Exported for tests — no git required. */
export function parseGitLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of raw.split(RS)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const [, author = "", at = "0", subject = ""] = header.split(US);
    const files =
      nl === -1
        ? []
        : chunk
            .slice(nl + 1)
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
    commits.push({
      author,
      at: Number(at) || 0,
      isFix: isFixSubject(subject),
      files,
    });
  }
  return commits;
}

/** Compute every signal from parsed commits. Pure — the testable half. */
export function signalsFromCommits(all: readonly Commit[]): Map<string, FileSignals> {
  const out = new Map<string, FileSignals>();
  // Automated commits are dropped before anything is computed. `authors`, `busFactor` and
  // `changeEntropy` exist to measure how many HUMANS touch a file; a bot with 400 dependency
  // bumps reads as the most involved contributor in the repository.
  const commits = all.filter((c) => !isBotAuthor(c.author));
  if (commits.length === 0) return out;

  // The window's most recent third defines "still active", for knowledgeLoss.
  const times = commits.map((c) => c.at).filter((t) => t > 0);
  const newest = times.length ? Math.max(...times) : 0;
  const oldest = times.length ? Math.min(...times) : 0;
  const span = newest - oldest;
  /**
   * Below this observed span, knowledgeLoss is reported as 0 for everyone.
   *
   * The signal asks "did this author leave?", and over a two-day history the most recent third
   * is sixteen hours — so a colleague who committed yesterday reads as departed. That is not a
   * weak signal, it is a wrong one. Found by a test whose fixture spanned two days; the
   * production window is six months, where the heuristic is sound.
   */
  const MIN_SPAN_FOR_DEPARTURE = 14 * 24 * 60 * 60;
  const canJudgeDeparture = span >= MIN_SPAN_FOR_DEPARTURE;
  const recentFrom = oldest + (span * 2) / 3;
  const activeAuthors = new Set(
    commits.filter((c) => c.at >= recentFrom).map((c) => c.author),
  );

  const perFile = new Map<
    string,
    {
      churn: number;
      byAuthor: Map<string, number>;
      coChange: Set<string>;
      priorDefect: number;
      times: number[];
    }
  >();

  for (const c of commits) {
    const countCoChange = c.files.length <= CO_CHANGE_MAX_FILES;
    for (const f of c.files) {
      let e = perFile.get(f);
      if (!e) {
        e = { churn: 0, byAuthor: new Map(), coChange: new Set(), priorDefect: 0, times: [] };
        perFile.set(f, e);
      }
      e.churn++;
      e.byAuthor.set(c.author, (e.byAuthor.get(c.author) ?? 0) + 1);
      if (c.isFix) e.priorDefect++;
      if (c.at > 0) e.times.push(c.at);
      if (countCoChange) {
        for (const other of c.files) if (other !== f) e.coChange.add(other);
      }
    }
  }

  for (const [file, e] of perFile) {
    const counts = [...e.byAuthor.values()].sort((a, b) => b - a);
    const total = counts.reduce((s, n) => s + n, 0);

    // Bus factor: how many of the top authors it takes to reach half the edits.
    let acc = 0;
    let busFactor = 0;
    for (const n of counts) {
      acc += n;
      busFactor++;
      if (acc * 2 >= total) break;
    }

    // Shannon entropy over the author distribution, normalised by log2(authors) so a
    // two-author file and a ten-author file are comparable.
    let entropy = 0;
    for (const n of counts) {
      const p = n / total;
      entropy -= p * Math.log2(p);
    }
    const maxEntropy = counts.length > 1 ? Math.log2(counts.length) : 0;

    let lost = 0;
    if (canJudgeDeparture) {
      for (const [author, n] of e.byAuthor) if (!activeAuthors.has(author)) lost += n;
    }

    out.set(file, {
      churn: e.churn,
      authors: e.byAuthor.size,
      ownershipRatio: total === 0 ? 0 : (counts[0] ?? 0) / total,
      busFactor,
      coChangeScatter: e.coChange.size,
      changeEntropy: maxEntropy === 0 ? 0 : entropy / maxEntropy,
      knowledgeLoss: total === 0 ? 0 : lost / total,
      priorDefect: e.priorDefect,
      ageVolatility: volatility(e.times),
    });
  }

  return out;
}

/**
 * Normalised coefficient of variation of the gaps between consecutive changes.
 *
 * Fewer than three changes gives 0 rather than a number: two timestamps produce exactly one
 * gap, whose variation is undefined, and reporting 0 for "not enough data" is honest where
 * reporting 1 would flag every rarely-touched file as volatile.
 */
function volatility(times: number[]): number {
  if (times.length < 3) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (mean === 0) return 0;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  // cv is unbounded; squash to 0..1 so it composes with the other normalised signals.
  return cv / (1 + cv);
}

/**
 * Read organisational signals for a working tree.
 *
 * Returns an empty map when the directory is not a git repository or git is unavailable —
 * the same failure posture as `churnByFile`, which these supersede.
 */
export interface GitWindow {
  /** Inclusive lower bound — anything `git log --since` accepts. */
  readonly since: string;
  /** Exclusive upper bound — anything `git log --until` accepts. Omit for "now". */
  readonly until?: string;
}

/**
 * Raw `git log` output for a window. Separated from parsing so the T0 boundary is one
 * auditable place: calibration correctness depends entirely on which commits are in scope.
 */
export function gitLogRange(root: string, window: GitWindow): string {
  const until = window.until === undefined ? "" : ` --until="${window.until}"`;
  return execSync(
    `git log --since="${window.since}"${until} --name-only --format="${RS}%H${US}%an${US}%at${US}%s"`,
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/**
 * Read organisational signals for a working tree.
 *
 * Returns an empty map when the directory is not a git repository or git is unavailable —
 * the same failure posture as `churnByFile`, which these supersede.
 *
 * `window` exists for calibration (PLAN.md §5.3), which must compute features from history
 * STRICTLY BEFORE a chosen T0 while labels come from after it. Passing a bare month count
 * cannot express that boundary.
 */
export function gitSignals(
  root: string,
  windowOrMonths: GitWindow | number = 6,
): Map<string, FileSignals> {
  const window: GitWindow =
    typeof windowOrMonths === "number"
      ? { since: `${windowOrMonths}.months.ago` }
      : windowOrMonths;
  try {
    return signalsFromCommits(parseGitLog(gitLogRange(root, window)));
  } catch {
    return new Map();
  }
}
