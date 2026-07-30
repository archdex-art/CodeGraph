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

/** Recognises a commit that fixes something, for `priorDefect`. */
const BUGFIX_RE =
  /\b(fix(e[sd])?|bugfix|hotfix|patch(e[sd])?|resolve[sd]?|close[sd]?)\b|\brevert\b|#\d+/i;

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

interface Commit {
  author: string;
  at: number;
  isFix: boolean;
  files: string[];
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
      isFix: BUGFIX_RE.test(subject),
      files,
    });
  }
  return commits;
}

/** Compute every signal from parsed commits. Pure — the testable half. */
export function signalsFromCommits(commits: Commit[]): Map<string, FileSignals> {
  const out = new Map<string, FileSignals>();
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
export function gitSignals(root: string, sinceMonths = 6): Map<string, FileSignals> {
  try {
    const raw = execSync(
      `git log --since="${sinceMonths}.months.ago" --name-only --format="${RS}%H${US}%an${US}%at${US}%s"`,
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return signalsFromCommits(parseGitLog(raw));
  } catch {
    return new Map();
  }
}
