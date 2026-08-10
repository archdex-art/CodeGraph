import { execFileSync } from "node:child_process";
import {
  GIT_LOG_FORMAT,
  busFactorOf,
  gitCommits,
  isBotAuthor,
  parseCommitHeader,
  type Commit,
  type GitWindow,
} from "./signals";

/**
 * Ownership, familiarity and reviewer recommendation from git history.
 *
 * Everything below the `git*` functions at the bottom is PURE over `readonly Commit[]`, for
 * the same reason `signalsFromCommits` is: this repository has a single author, so every
 * author-derived number is degenerate against its own history and can only be tested against
 * a fixture. A function that shells out cannot take a fixture.
 *
 * ONE DEFINITION OF EACH CONCEPT. "Bus factor" is `busFactorOf` in `signals.ts`, imported
 * rather than restated. "Active" is the most recent third of the window, which is exactly
 * what `signalsFromCommits` uses for `knowledgeLoss` — a second threshold would let the file
 * view call someone departed while the reviewer list still routes reviews to them.
 *
 * WHAT THIS IS NOT. These are rankings over observed commit history, not measurements of
 * knowledge. Someone who reviewed every PR against a file and never committed to it is
 * invisible here, and someone who ran a formatter over the tree owns everything. The reviewer
 * weights are hand-picked; they order a list, and no part of the Health Score reads them.
 */

const DAY = 86_400;

/**
 * The recent third of the window must be at least this many days for "inactive" to mean
 * anything.
 *
 * Same reasoning, and deliberately the same number, as `MIN_SPAN_FOR_DEPARTURE` in
 * `signals.ts`: over a two-day history the recent third is sixteen hours, so a colleague who
 * committed yesterday reads as departed. Below the floor, `orphaned` is reported as false and
 * no reviewer is excluded for inactivity — an under-claim rather than a wrong claim.
 */
const MIN_RECENT_DAYS = 14;

/** Default history window, in days. 180 to match `gitSignals`' six-month default. */
const DEFAULT_WINDOW_DAYS = 180;

/** Files carried in an `OwnershipReport`. Beyond this the report is marked truncated. */
const DEFAULT_MAX_FILES = 5_000;

/**
 * Owners listed per file. The rest still count towards `busFactor` and `orphaned`, which are
 * computed over every author of the file — a cap on what is DISPLAYED must not change what is
 * MEASURED.
 */
const MAX_OWNERS_PER_FILE = 10;

/**
 * Mirrors `CO_CHANGE_MAX_FILES` in `signals.ts`. A commit touching more files than this is a
 * rename sweep or a formatter run: it says nothing about which files belong together, and
 * including it makes every file look coupled to every other.
 */
const CO_CHANGE_MAX_FILES = 50;

/** Changed files a single `recommendReviewers` call will weigh. A 900-file PR is a rename. */
const MAX_CHANGED_FILES = 50;

/** Coupled files considered per changed file, taken by co-change count descending. */
const MAX_COUPLED_FILES = 20;

/** Reviewers returned when the caller does not say. */
const DEFAULT_MAX_REVIEWERS = 5;

/** Directory levels rolled up by `staleAreas`. A deeper path contributes its top 8. */
const MAX_DIR_DEPTH = 8;

/**
 * Commits read by the hunk-level pass, and the ceiling on any caller-supplied override.
 *
 * `git log -p -U0` emits every changed line of every commit; on a large repository six months
 * of that is hundreds of megabytes. Symbol attribution wants recency far more than depth — a
 * symbol last touched 200 commits ago is not one anybody remembers — so the pass is bounded by
 * commit count as well as by `maxBuffer`, and reports that it was.
 */
const MAX_HUNK_COMMITS = 500;
const DEFAULT_HUNK_COMMITS = 200;

/** Hunk-log output ceiling. Exceeding it throws ENOBUFS, which `gitOwnership` turns into a
 *  report with no symbol attribution rather than a failed index. */
const HUNK_MAX_BUFFER = 32 * 1024 * 1024;

/** Changed line ranges kept per file per commit. A generated bundle produces thousands. */
const MAX_RANGES_PER_FILE = 2_000;

/** Commits `parseGitLogHunks` will parse out of one payload, however large the payload. */
const MAX_PARSED_HUNK_COMMITS = 1_000;

/**
 * Range-versus-symbol comparisons `symbolOwnership` will perform before giving up.
 *
 * The intersection is a nested loop over (commits × files × ranges × symbols in that file),
 * and all four factors come from the repository under analysis. 20M comparisons is a few
 * hundred milliseconds; past that the caller gets `truncated: true` and a partial map, which
 * is the same posture the scan takes when it hits its file cap.
 */
const MAX_ATTRIBUTION_STEPS = 20_000_000;

/** Field/record separators, matching `GIT_LOG_FORMAT` in `signals.ts`. */
const RS = "\x1e";

// ── Shapes ────────────────────────────────────────────────────────────────────────────────
// Declared here and MIRRORED in `@codegraph/analysis-model`, not shared with it: this package
// sits below the model in the layer graph (.dependency-cruiser.cjs — `vcs` may import only
// core-domain, config, observability, fsx), exactly as `FileSignals` already is.

export interface AuthorStat {
  readonly name: string;
  readonly email: string;
  readonly commits: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly filesTouched: number;
}

export interface FileOwner {
  readonly author: string;
  readonly share: number;
  readonly commits: number;
  readonly lastAt: number;
}

export interface OwnershipEntry {
  readonly path: string;
  readonly owners: readonly FileOwner[];
  readonly busFactor: number;
  readonly staleDays: number | null;
  readonly orphaned: boolean;
}

export interface SymbolOwnership {
  readonly symbolId: string;
  readonly owners: ReadonlyArray<{ author: string; share: number }>;
}

export interface OwnershipReport {
  readonly authors: readonly AuthorStat[];
  readonly files: readonly OwnershipEntry[];
  readonly symbols: readonly SymbolOwnership[];
  readonly windowDays: number;
  readonly commitsAnalysed: number;
  readonly truncated: boolean;
}

/**
 * The part of `CodeSymbol` this module needs.
 *
 * Structural rather than imported: `core-graph` is not in `vcs`'s allowlist, and a
 * `CodeSymbol` satisfies this shape, so `indexRepo` passes its symbols straight in.
 */
export interface SymbolSpan {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
}

export interface OwnershipOptions {
  /** Length of the window `commits` were drawn from, in days. Drives every threshold. */
  readonly windowDays: number;
  /** Evaluation instant, epoch seconds. Defaults to the newest commit in `commits`. */
  readonly now?: number;
  /** Files carried in the output; the rest are dropped and the report marked truncated. */
  readonly maxFiles?: number;
}

export interface ReviewerOptions extends OwnershipOptions {
  readonly maxReviewers?: number;
}

export interface ReviewerRecommendation {
  readonly author: string;
  /** 0..1, rounded to four places. A RANKING, not a probability. */
  readonly score: number;
  /** Why, in the data's own terms. Never empty, never generic. */
  readonly reasons: readonly string[];
}

export interface FamiliarityEntry {
  readonly path: string;
  /** This author's share of the path's edits, 0..1. */
  readonly share: number;
  readonly commits: number;
}

export interface Familiarity {
  /** The canonical name matched, or the caller's string when nothing matched. */
  readonly author: string;
  /**
   * False when no commit in the window belongs to `author`.
   *
   * Explicit, because an unmatched author and an author who happens to have touched nothing
   * both produce empty lists, and the two mean opposite things.
   */
  readonly matched: boolean;
  /** Share of ALL file-edits in the window made by this author, 0..1. */
  readonly overall: number;
  readonly files: readonly FamiliarityEntry[];
  readonly directories: readonly FamiliarityEntry[];
}

export interface StaleArea {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly lastAt: number;
  readonly staleDays: number;
  /** Every author of this area is inactive. Always false when the window is too short. */
  readonly orphaned: boolean;
  /** Canonical author names, most edits first. */
  readonly owners: readonly string[];
}

export interface FileHunks {
  readonly path: string;
  /** Inclusive `[start, end]` line ranges in this commit's POST-image of the file. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

export interface CommitHunks {
  readonly sha: string;
  readonly author: string;
  readonly email: string;
  readonly at: number;
  readonly files: readonly FileHunks[];
}

export interface SymbolAttribution {
  readonly symbols: readonly SymbolOwnership[];
  /** The hunk pass or the intersection hit a bound, so this is a partial attribution. */
  readonly truncated: boolean;
  /** Commits that intersected at least one symbol. */
  readonly attributedCommits: number;
}

// ── Identity ──────────────────────────────────────────────────────────────────────────────

/**
 * The key two commits must share to be the same person.
 *
 * Lowercased email when git recorded one, lowercased name otherwise. Called from six places
 * and they MUST agree: canonicalising one way in `authorStats` and another in
 * `fileOwnership` produces a report whose author list does not contain the owners it names.
 *
 * KNOWN LIMITATION, stated rather than papered over: one person committing from two addresses
 * ("ada@work" at the office, "ada@home" at night) reads as two authors, which understates
 * ownership share and overstates bus factor. Merging on name as well would fix that case and
 * break the more common one, where "root", "ubuntu" and "unknown" are several people. A
 * `.mailmap` reader is the real answer; git already defines that file's semantics and this
 * module does not read it yet.
 */
export function identityKey(commit: Commit): string {
  const email = commit.email.trim().toLowerCase();
  return email || commit.author.trim().toLowerCase();
}

interface Identity {
  name: string;
  email: string;
  commits: number;
  firstAt: number;
  lastAt: number;
  files: Set<string>;
  /** Spelling frequency, so the displayed name is the one the person uses most. */
  nameCounts: Map<string, number>;
  emailCounts: Map<string, number>;
}

/**
 * Most frequent value, ties broken lexicographically.
 *
 * The tie-break is not cosmetic: without it the winner depends on Map insertion order, which
 * depends on the order git returned the commits, and the report stops being reproducible.
 */
function dominant(counts: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const key of [...counts.keys()].sort()) {
    const n = counts.get(key) ?? 0;
    if (n > bestCount) {
      best = key;
      bestCount = n;
    }
  }
  return best;
}

/** Human commits only, grouped by canonical identity. The base of everything below. */
function identities(commits: readonly Commit[]): Map<string, Identity> {
  const out = new Map<string, Identity>();
  for (const c of commits) {
    if (isBotAuthor(c.author)) continue;
    const key = identityKey(c);
    if (!key) continue;
    let id = out.get(key);
    if (!id) {
      id = {
        name: "",
        email: "",
        commits: 0,
        firstAt: 0,
        lastAt: 0,
        files: new Set(),
        nameCounts: new Map(),
        emailCounts: new Map(),
      };
      out.set(key, id);
    }
    id.commits++;
    const name = c.author.trim();
    if (name) id.nameCounts.set(name, (id.nameCounts.get(name) ?? 0) + 1);
    const email = c.email.trim();
    if (email) id.emailCounts.set(email, (id.emailCounts.get(email) ?? 0) + 1);
    if (c.at > 0) {
      id.firstAt = id.firstAt === 0 ? c.at : Math.min(id.firstAt, c.at);
      id.lastAt = Math.max(id.lastAt, c.at);
    }
    for (const f of c.files) id.files.add(f);
  }
  for (const id of out.values()) {
    id.name = dominant(id.nameCounts);
    id.email = dominant(id.emailCounts);
  }
  return out;
}

/** Canonical display name per identity key, for everything that reports an author. */
function displayNames(ids: Map<string, Identity>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, id] of ids) out.set(key, id.name || id.email || key);
  return out;
}

export function authorStats(commits: readonly Commit[]): AuthorStat[] {
  const stats: AuthorStat[] = [];
  for (const id of identities(commits).values()) {
    stats.push({
      name: id.name || id.email,
      email: id.email,
      commits: id.commits,
      firstAt: id.firstAt,
      lastAt: id.lastAt,
      filesTouched: id.files.size,
    });
  }
  // Commits descending, then name ascending. The second key is what makes the list stable
  // across runs when two people have committed the same number of times.
  stats.sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  return stats;
}

// ── Window arithmetic ─────────────────────────────────────────────────────────────────────

interface Window {
  /** Evaluation instant, epoch seconds. */
  readonly now: number;
  /** Start of the most recent third. A commit at or after this counts as active. */
  readonly recentFrom: number;
  /** Whether the recent third is long enough for "inactive" to mean anything. */
  readonly canJudgeActivity: boolean;
  readonly windowDays: number;
}

function resolveWindow(commits: readonly Commit[], opts: OwnershipOptions): Window {
  const windowDays = opts.windowDays > 0 ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  /**
   * `now` defaults to the NEWEST COMMIT, not to the wall clock.
   *
   * A report over a fixture, a recorded log, or a repository whose last commit was two years
   * ago must not read as "everything is stale": staleness is measured against the end of the
   * history being analysed. A caller looking at a live checkout passes `Date.now()/1000`.
   */
  let newest = 0;
  for (const c of commits) if (c.at > newest) newest = c.at;
  const now = opts.now ?? newest;
  const recentDays = windowDays / 3;
  return {
    now,
    recentFrom: now - recentDays * DAY,
    canJudgeActivity: recentDays >= MIN_RECENT_DAYS,
    windowDays,
  };
}

/** "today" / "1 day ago" / "17 days ago". Used verbatim in reviewer reasons. */
function agePhrase(now: number, at: number): string {
  if (at <= 0) return "at an unknown time";
  const days = Math.max(0, Math.floor((now - at) / DAY));
  if (days === 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// ── Per-file aggregation ──────────────────────────────────────────────────────────────────

interface FileFacts {
  commits: number;
  lastAt: number;
  /** identity key -> edits and the author's most recent edit to this file. */
  byAuthor: Map<string, { commits: number; lastAt: number }>;
}

function fileFacts(commits: readonly Commit[]): Map<string, FileFacts> {
  const out = new Map<string, FileFacts>();
  for (const c of commits) {
    if (isBotAuthor(c.author)) continue;
    const key = identityKey(c);
    if (!key) continue;
    for (const path of c.files) {
      let f = out.get(path);
      if (!f) {
        f = { commits: 0, lastAt: 0, byAuthor: new Map() };
        out.set(path, f);
      }
      f.commits++;
      if (c.at > f.lastAt) f.lastAt = c.at;
      const a = f.byAuthor.get(key);
      if (a) {
        a.commits++;
        if (c.at > a.lastAt) a.lastAt = c.at;
      } else {
        f.byAuthor.set(key, { commits: 1, lastAt: c.at });
      }
    }
  }
  return out;
}

/** Identity keys with at least one commit in the recent third of the window. */
function activeKeys(commits: readonly Commit[], window: Window): Set<string> {
  const out = new Set<string>();
  for (const c of commits) {
    if (isBotAuthor(c.author)) continue;
    if (c.at >= window.recentFrom) out.add(identityKey(c));
  }
  return out;
}

export function fileOwnership(
  commits: readonly Commit[],
  opts: OwnershipOptions,
): OwnershipEntry[] {
  const window = resolveWindow(commits, opts);
  const names = displayNames(identities(commits));
  const active = activeKeys(commits, window);
  const facts = fileFacts(commits);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

  // Selection is by edit count so a cap keeps the files anybody cares about, but the OUTPUT is
  // sorted by path: a consumer diffing two reports must not see rows move because one commit
  // landed.
  const paths = [...facts.keys()].sort(
    (a, b) => (facts.get(b)?.commits ?? 0) - (facts.get(a)?.commits ?? 0) || a.localeCompare(b),
  );

  const entries: OwnershipEntry[] = [];
  for (const path of paths.slice(0, maxFiles)) {
    const f = facts.get(path);
    if (!f) continue;
    const owners: FileOwner[] = [];
    let allInactive = true;
    for (const [key, a] of f.byAuthor) {
      if (active.has(key)) allInactive = false;
      owners.push({
        author: names.get(key) ?? key,
        share: a.commits / f.commits,
        commits: a.commits,
        lastAt: a.lastAt,
      });
    }
    owners.sort((x, y) => y.share - x.share || x.author.localeCompare(y.author));
    entries.push({
      path,
      owners: owners.slice(0, MAX_OWNERS_PER_FILE),
      // Over EVERY author, not the displayed slice — see MAX_OWNERS_PER_FILE.
      busFactor: busFactorOf([...f.byAuthor.values()].map((a) => a.commits)),
      staleDays: f.lastAt > 0 ? Math.max(0, Math.floor((window.now - f.lastAt) / DAY)) : null,
      orphaned: window.canJudgeActivity && allInactive,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** Every ancestor directory of a repo-relative path, nearest first, bounded by depth. */
function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  const dirs: string[] = [];
  for (let cut = parts.length - 1; cut >= 1 && dirs.length < MAX_DIR_DEPTH; cut--) {
    dirs.push(parts.slice(0, cut).join("/"));
  }
  return dirs;
}

/**
 * Files and directories nobody has touched in the recent third of the window.
 *
 * The threshold is DERIVED from the window rather than picked: "stale" is "older than the
 * boundary that already decides who is active", so a 30-day window calls a 12-day-old file
 * stale and a 360-day window does not. One boundary, two questions — which is why an area can
 * never be `orphaned` without also being stale.
 */
export function staleAreas(commits: readonly Commit[], opts: OwnershipOptions): StaleArea[] {
  const window = resolveWindow(commits, opts);
  const names = displayNames(identities(commits));
  const active = activeKeys(commits, window);
  const facts = fileFacts(commits);

  const areas = new Map<string, { kind: "file" | "directory"; lastAt: number; byAuthor: Map<string, number> }>();
  const add = (path: string, kind: "file" | "directory", f: FileFacts): void => {
    let a = areas.get(path);
    if (!a) {
      a = { kind, lastAt: 0, byAuthor: new Map() };
      areas.set(path, a);
    }
    if (f.lastAt > a.lastAt) a.lastAt = f.lastAt;
    for (const [key, stat] of f.byAuthor) a.byAuthor.set(key, (a.byAuthor.get(key) ?? 0) + stat.commits);
  };
  for (const [path, f] of facts) {
    add(path, "file", f);
    for (const dir of ancestorDirs(path)) add(dir, "directory", f);
  }

  const out: StaleArea[] = [];
  for (const [path, a] of areas) {
    if (a.lastAt <= 0 || a.lastAt >= window.recentFrom) continue;
    const owners = [...a.byAuthor.entries()]
      .map(([key, n]) => ({ author: names.get(key) ?? key, edits: n, key }))
      .sort((x, y) => y.edits - x.edits || x.author.localeCompare(y.author));
    out.push({
      path,
      kind: a.kind,
      lastAt: a.lastAt,
      staleDays: Math.max(0, Math.floor((window.now - a.lastAt) / DAY)),
      orphaned: window.canJudgeActivity && owners.every((o) => !active.has(o.key)),
      owners: owners.map((o) => o.author),
    });
  }
  out.sort((a, b) => b.staleDays - a.staleDays || a.path.localeCompare(b.path));
  return out;
}

/**
 * One author's share of the edits to every file and directory they have touched.
 *
 * `author` is matched against the canonical name OR any email/name spelling, case-insensitive,
 * so a caller holding a display name from `authorStats` and one holding a raw git email both
 * resolve to the same person.
 */
export function familiarity(commits: readonly Commit[], author: string): Familiarity {
  const wanted = author.trim().toLowerCase();
  const ids = identities(commits);
  const names = displayNames(ids);
  let matchedKey: string | null = null;
  for (const key of [...ids.keys()].sort()) {
    const id = ids.get(key);
    if (!id) continue;
    if (
      key === wanted ||
      id.name.toLowerCase() === wanted ||
      id.email.toLowerCase() === wanted ||
      [...id.nameCounts.keys()].some((n) => n.toLowerCase() === wanted) ||
      [...id.emailCounts.keys()].some((e) => e.toLowerCase() === wanted)
    ) {
      matchedKey = key;
      break;
    }
  }
  if (matchedKey === null) {
    return { author, matched: false, overall: 0, files: [], directories: [] };
  }

  const facts = fileFacts(commits);
  const files: FamiliarityEntry[] = [];
  const dirTotals = new Map<string, { mine: number; all: number }>();
  let mineAll = 0;
  let editsAll = 0;
  for (const [path, f] of facts) {
    const mine = f.byAuthor.get(matchedKey)?.commits ?? 0;
    editsAll += f.commits;
    mineAll += mine;
    if (mine > 0) files.push({ path, share: mine / f.commits, commits: mine });
    for (const dir of ancestorDirs(path)) {
      const d = dirTotals.get(dir) ?? { mine: 0, all: 0 };
      d.mine += mine;
      d.all += f.commits;
      dirTotals.set(dir, d);
    }
  }
  const directories: FamiliarityEntry[] = [];
  for (const [path, d] of dirTotals) {
    if (d.mine > 0) directories.push({ path, share: d.mine / d.all, commits: d.mine });
  }
  const bySharethenPath = (a: FamiliarityEntry, b: FamiliarityEntry): number =>
    b.share - a.share || b.commits - a.commits || a.path.localeCompare(b.path);
  files.sort(bySharethenPath);
  directories.sort(bySharethenPath);
  return {
    author: names.get(matchedKey) ?? author,
    matched: true,
    overall: editsAll === 0 ? 0 : mineAll / editsAll,
    files,
    directories,
  };
}

// ── Reviewer recommendation ───────────────────────────────────────────────────────────────

/**
 * Component weights.
 *
 * HAND-PICKED, and that is a real caveat rather than a formality: nothing fitted them against
 * accepted-review data, because this project has none. They order a list of at most five names
 * and no part of the Health Score reads them, which is the only reason hand-picking is
 * acceptable here when PLAN.md §5.3 says it is not for the score.
 *
 * Ownership leads because "who wrote this" is the question a reviewer request actually asks.
 * Recency is second and is a GATE as much as a weight — an inactive author is dropped outright
 * below. Co-change is last and small: it finds the person who owns the caller of the thing you
 * changed, which is genuinely useful and genuinely noisier than the other two.
 */
const W_OWNERSHIP = 0.45;
const W_RECENCY = 0.35;
const W_COUPLING = 0.2;

interface Candidate {
  ownership: number;
  coupling: number;
  /** Most recent touch of a changed or coupled file, epoch seconds. */
  lastTouch: number;
  /** Best-owned changed file, for the reason line. */
  bestFile: { path: string; share: number; mine: number; total: number } | null;
  /** Strongest coupling evidence, for the reason line. */
  bestCoupling: { changed: string; coupled: string; both: number; total: number } | null;
}

export function recommendReviewers(
  commits: readonly Commit[],
  changedFiles: readonly string[],
  opts: ReviewerOptions,
): ReviewerRecommendation[] {
  const window = resolveWindow(commits, opts);
  const ids = identities(commits);
  const names = displayNames(ids);
  const active = activeKeys(commits, window);
  const facts = fileFacts(commits);

  // Deduplicated and sorted so two callers passing the same set in different orders get the
  // same ranking, and so the cap takes a deterministic subset of an oversized change.
  const changed = [...new Set(changedFiles.map((f) => f.trim()).filter(Boolean))]
    .sort()
    .slice(0, MAX_CHANGED_FILES);
  if (changed.length === 0) return [];

  // Co-change counts, built only for the changed files: a full pairwise matrix over a whole
  // repository is quadratic in file count and every row but these would be discarded.
  const changedSet = new Set(changed);
  const coChange = new Map<string, Map<string, number>>();
  for (const c of commits) {
    if (isBotAuthor(c.author)) continue;
    if (c.files.length > CO_CHANGE_MAX_FILES) continue;
    for (const f of c.files) {
      if (!changedSet.has(f)) continue;
      let row = coChange.get(f);
      if (!row) {
        row = new Map();
        coChange.set(f, row);
      }
      for (const other of c.files) {
        if (other !== f) row.set(other, (row.get(other) ?? 0) + 1);
      }
    }
  }

  const candidates = new Map<string, Candidate>();
  const take = (key: string): Candidate => {
    let cand = candidates.get(key);
    if (!cand) {
      cand = { ownership: 0, coupling: 0, lastTouch: 0, bestFile: null, bestCoupling: null };
      candidates.set(key, cand);
    }
    return cand;
  };

  const halfLifeDays = Math.max(1, window.windowDays / 2);
  for (const path of changed) {
    const f = facts.get(path);
    if (!f) continue;
    for (const [key, a] of f.byAuthor) {
      const cand = take(key);
      const share = a.commits / f.commits;
      cand.ownership += share;
      if (a.lastAt > cand.lastTouch) cand.lastTouch = a.lastAt;
      if (cand.bestFile === null || share > cand.bestFile.share) {
        cand.bestFile = { path, share, mine: a.commits, total: f.commits };
      }
    }
    const row = coChange.get(path);
    if (!row) continue;
    const coupled = [...row.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, MAX_COUPLED_FILES);
    for (const [other, both] of coupled) {
      const g = facts.get(other);
      if (!g) continue;
      const strength = both / f.commits;
      for (const [key, a] of g.byAuthor) {
        const cand = take(key);
        cand.coupling += (a.commits / g.commits) * strength;
        if (a.lastAt > cand.lastTouch) cand.lastTouch = a.lastAt;
        if (cand.bestCoupling === null || both > cand.bestCoupling.both) {
          cand.bestCoupling = { changed: path, coupled: other, both, total: f.commits };
        }
      }
    }
  }

  const out: ReviewerRecommendation[] = [];
  for (const key of [...candidates.keys()].sort()) {
    const cand = candidates.get(key);
    if (!cand) continue;
    /**
     * The exclusion, and the reason recency is a gate rather than only a weight: routing a
     * review to someone who left the team three months ago is worse than routing it to nobody,
     * because the request sits unanswered and looks handled.
     */
    if (window.canJudgeActivity && !active.has(key)) continue;
    const ownership = Math.min(1, cand.ownership / changed.length);
    const coupling = Math.min(1, cand.coupling / changed.length);
    const ageDays = cand.lastTouch > 0 ? Math.max(0, (window.now - cand.lastTouch) / DAY) : Infinity;
    // Exponential decay: a touch one half-life back counts half as much as one today.
    const recency = ageDays === Infinity ? 0 : 2 ** (-ageDays / halfLifeDays);
    const score = W_OWNERSHIP * ownership + W_RECENCY * recency + W_COUPLING * coupling;
    if (score <= 0) continue;

    const reasons: string[] = [];
    if (cand.bestFile && cand.bestFile.share > 0) {
      const b = cand.bestFile;
      reasons.push(
        `owns ${Math.round(b.share * 100)}% of ${b.path} (${b.mine} of ${b.total} commits)`,
      );
    }
    if (cand.lastTouch > 0) {
      reasons.push(`last touched this area ${agePhrase(window.now, cand.lastTouch)}`);
    }
    if (cand.bestCoupling && coupling > 0) {
      const b = cand.bestCoupling;
      reasons.push(
        `edits ${b.coupled}, which changes alongside ${b.changed} in ${b.both} of ${b.total} commits`,
      );
    }
    out.push({
      author: names.get(key) ?? key,
      // Four places: enough to separate genuinely different fits, coarse enough that two
      // authors with identical history land on an exact tie the name sort then resolves.
      score: Math.round(score * 10_000) / 10_000,
      reasons,
    });
  }
  out.sort((a, b) => b.score - a.score || a.author.localeCompare(b.author));
  return out.slice(0, Math.max(1, opts.maxReviewers ?? DEFAULT_MAX_REVIEWERS));
}

// ── Hunk parsing and symbol attribution ───────────────────────────────────────────────────

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git log -p --unified=0` output into per-commit changed line ranges.
 *
 * Pure, so the hunk grammar is testable without a repository — the reason it is separated from
 * `gitHunkLog` at all.
 *
 * ONE PARSING SUBTLETY THAT IS A SECURITY PROPERTY. A file's own content can contain lines
 * that look like diff metadata; a committed patch file is the obvious case. `--unified=0`
 * emits no context lines, so every content line is prefixed with `+` or `-` and can never
 * begin at column 0 with `diff --git `. Within a file's header — between `diff --git` and its
 * first `@@` — git emits only its own lines, so `+++ ` there is trustworthy. AFTER the first
 * hunk header, `+++ b/etc/passwd` is an ADDED LINE whose content is `++ b/etc/passwd`, so the
 * parser stops honouring `+++` until the next `diff --git`. Without that state flag a crafted
 * file reassigns subsequent hunks to a path of the committer's choosing.
 */
export function parseGitLogHunks(raw: string): CommitHunks[] {
  const commits: CommitHunks[] = [];
  for (const chunk of raw.split(RS)) {
    if (!chunk.trim()) continue;
    if (commits.length >= MAX_PARSED_HUNK_COMMITS) break;
    const nl = chunk.indexOf("\n");
    const header = parseCommitHeader(nl === -1 ? chunk : chunk.slice(0, nl));
    const files: FileHunks[] = [];
    let path: string | null = null;
    let ranges: Array<readonly [number, number]> = [];
    let inHunks = false;
    const flush = (): void => {
      if (path !== null && ranges.length > 0) files.push({ path, ranges });
      path = null;
      ranges = [];
      inHunks = false;
    };
    if (nl !== -1) {
      for (const line of chunk.slice(nl + 1).split("\n")) {
        if (line.startsWith("diff --git ")) {
          flush();
          continue;
        }
        if (!inHunks && line.startsWith("+++ ")) {
          const target = line.slice(4).trim();
          // A deletion writes `+++ /dev/null`: the file has no post-image and therefore no
          // symbol in the current tree to attribute anything to.
          path = target === "/dev/null" ? null : target.replace(/^b\//, "");
          continue;
        }
        const m = HUNK_HEADER_RE.exec(line);
        if (!m) continue;
        inHunks = true;
        if (path === null || ranges.length >= MAX_RANGES_PER_FILE) continue;
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (!Number.isFinite(start)) continue;
        // `+N,0` is a pure deletion: nothing exists at N in the post-image, and the removal
        // sits between N and N+1. Attributed to line max(N,1) — the symbol that lost the code
        // is the one that contained the line above it.
        if (count === 0) {
          const at = Math.max(1, start);
          ranges.push([at, at]);
        } else {
          ranges.push([start, start + count - 1]);
        }
      }
    }
    flush();
    commits.push({ sha: header.sha, author: header.author, email: header.email, at: header.at, files });
  }
  return commits;
}

/**
 * Attribute commits to symbols by intersecting changed line ranges with symbol spans.
 *
 * THE LIMITATION, up front. Symbols are the CURRENT tree's. A commit's hunks are line numbers
 * in THAT commit's post-image, and every commit since has moved them: insert twenty lines at
 * the top of a file and every symbol below shifts by twenty. Resolving that honestly requires
 * checking out each commit and re-extracting its symbols, which is O(commits) parses of the
 * whole tree — minutes per repository, not the seconds an index has.
 *
 * So this is an APPROXIMATION, and it degrades in one direction with age: recent commits are
 * attributed accurately, old ones drift towards whatever now occupies those lines. `share` is
 * therefore a hint about who to ask, never a claim about who wrote a given line — `git blame`
 * answers that exactly and costs a subprocess per file.
 */
export function symbolOwnership(
  hunks: readonly CommitHunks[],
  symbols: readonly SymbolSpan[],
): SymbolAttribution {
  const byFile = new Map<string, SymbolSpan[]>();
  for (const s of symbols) {
    const list = byFile.get(s.file);
    if (list) list.push(s);
    else byFile.set(s.file, [s]);
  }

  /** symbol id -> identity key -> commits touching it. */
  const touched = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();
  const nameCounts = new Map<string, Map<string, number>>();
  let steps = 0;
  let truncated = false;
  let attributedCommits = 0;

  for (const commit of hunks) {
    if (truncated) break;
    if (isBotAuthor(commit.author)) continue;
    const email = commit.email.trim().toLowerCase();
    const key = email || commit.author.trim().toLowerCase();
    if (!key) continue;
    const spelling = nameCounts.get(key) ?? new Map<string, number>();
    const name = commit.author.trim();
    if (name) spelling.set(name, (spelling.get(name) ?? 0) + 1);
    nameCounts.set(key, spelling);

    // A commit is counted ONCE per symbol however many of its hunks land inside it, so a
    // sweeping reformat of one function does not outweigh ten separate edits to it.
    const hit = new Set<string>();
    for (const file of commit.files) {
      const spans = byFile.get(file.path);
      if (!spans) continue;
      steps += spans.length * file.ranges.length;
      if (steps > MAX_ATTRIBUTION_STEPS) {
        truncated = true;
        break;
      }
      for (const span of spans) {
        for (const [start, end] of file.ranges) {
          if (start <= span.endLine && end >= span.line) {
            hit.add(span.id);
            break;
          }
        }
      }
    }
    if (hit.size === 0) continue;
    attributedCommits++;
    for (const id of hit) {
      const owners = touched.get(id) ?? new Map<string, number>();
      owners.set(key, (owners.get(key) ?? 0) + 1);
      touched.set(id, owners);
    }
  }
  for (const [key, spelling] of nameCounts) names.set(key, dominant(spelling) || key);

  const out: SymbolOwnership[] = [];
  for (const [symbolId, owners] of touched) {
    let total = 0;
    for (const n of owners.values()) total += n;
    if (total === 0) continue;
    const list = [...owners.entries()]
      .map(([key, n]) => ({ author: names.get(key) ?? key, share: n / total }))
      .sort((a, b) => b.share - a.share || a.author.localeCompare(b.author));
    out.push({ symbolId, owners: list });
  }
  out.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
  return { symbols: out, truncated, attributedCommits };
}

// ── Assembly ──────────────────────────────────────────────────────────────────────────────

export interface ReportOptions extends OwnershipOptions {
  /** Symbol attribution, when the caller ran the hunk pass. Omitted means "not attempted". */
  readonly symbols?: readonly SymbolOwnership[];
  /** Set when the history itself was cut short — a commit cap, a buffer overflow. */
  readonly truncated?: boolean;
}

/** Assemble the report from an already-read history. Pure. */
export function ownershipReport(
  commits: readonly Commit[],
  opts: ReportOptions,
): OwnershipReport {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const files = fileOwnership(commits, opts);
  const distinctFiles = new Set<string>();
  for (const c of commits) if (!isBotAuthor(c.author)) for (const f of c.files) distinctFiles.add(f);
  return {
    authors: authorStats(commits),
    files,
    symbols: opts.symbols ?? [],
    windowDays: opts.windowDays,
    commitsAnalysed: commits.filter((c) => !isBotAuthor(c.author)).length,
    truncated: (opts.truncated ?? false) || distinctFiles.size > maxFiles,
  };
}

// ── git access ────────────────────────────────────────────────────────────────────────────

export interface HunkLogOptions {
  /** Commits to read, clamped to 1..MAX_HUNK_COMMITS. */
  readonly maxCommits?: number;
}

/**
 * Raw `git log -p --unified=0` output for a window.
 *
 * A SECOND INVOCATION, unavoidably. `--name-only` and `-p` are mutually exclusive output modes
 * — git emits one or the other — so the single pass `gitCommits` makes cannot also yield line
 * ranges. It is bounded on both axes that can run away (commit count and output bytes) and
 * every caller treats a failure as "no symbol attribution" rather than as an error, so the
 * expensive half of ownership is always skippable.
 *
 * `core.quotePath=false` keeps non-ASCII paths readable instead of C-escaped, which the path
 * parse would otherwise have to undo. Passed as a `-c` argv token before the subcommand, and
 * the window values are glued into single `--since=`/`--until=` tokens for the same
 * argument-injection reason as `gitLogRange`.
 */
export function gitHunkLog(root: string, window: GitWindow, opts?: HunkLogOptions): string {
  const requested = Math.floor(opts?.maxCommits ?? DEFAULT_HUNK_COMMITS);
  const maxCommits = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_HUNK_COMMITS, requested))
    : DEFAULT_HUNK_COMMITS;
  const args = [
    "-c",
    "core.quotePath=false",
    "log",
    `--since=${window.since}`,
    ...(window.until === undefined ? [] : [`--until=${window.until}`]),
    `--max-count=${maxCommits}`,
    "--unified=0",
    "--no-color",
    "--no-renames",
    "-p",
    `--format=${GIT_LOG_FORMAT}`,
    /**
     * SCOPED TO THE ANALYSED SUBTREE, and this is what makes the pass survive a monorepo.
     *
     * `git log` run inside a subdirectory still walks the WHOLE repository — the cwd narrows
     * nothing without a pathspec. On this repository, 200 commits of full `-p -U0` output blew
     * the 32 MiB buffer, `execFileSync` threw ENOBUFS, and the caller's catch turned that into
     * "no symbol attribution" — a feature that silently never worked, on exactly the repos big
     * enough to want it.
     *
     * `.` rather than the prefix string: git resolves a pathspec relative to cwd, which is
     * already `root`. That keeps repository-controlled text out of the argv entirely, and the
     * separator makes it a pathspec even if a branch shares the name.
     */
    "--",
    ".",
  ];
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: HUNK_MAX_BUFFER,
  });
}

/**
 * The analysed root's path prefix inside its git repository — `apps/web/` for a subdirectory,
 * `""` when `root` IS the repository root.
 *
 * THE MISMATCH THIS EXISTS TO CLOSE. `git log` always reports paths relative to the REPOSITORY
 * root, whatever directory it is run from. Everything else in the pipeline — the symbol graph,
 * the viz nodes, the findings — uses paths relative to the ANALYSED root. Index a subdirectory
 * of a repository and the two never match: every ownership entry is keyed
 * `apps/web/src/lib/store.ts` while every symbol is keyed `src/lib/store.ts`, so file lookups
 * miss silently and symbol attribution intersects nothing at all. Measured: indexing
 * `apps/web` of this repository produced 2,639 owned files and ZERO attributed symbols.
 *
 * Empty string on any failure, which is the identity transform — a repository whose prefix we
 * cannot read behaves exactly as it did before this existed.
 */
function repoPathPrefix(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Re-key commits onto the analysed root, dropping files outside it.
 *
 * Dropping is correct rather than lossy: a commit that also touched a sibling directory did not
 * touch THIS tree there, and counting it would attribute edits to files the index has never
 * seen. A commit left with no in-scope files is dropped whole, so it cannot inflate an author's
 * commit count with work that happened elsewhere.
 */
function rebaseCommits(commits: readonly Commit[], prefix: string): Commit[] {
  if (prefix === "") return [...commits];
  const out: Commit[] = [];
  for (const c of commits) {
    const files = c.files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    if (files.length === 0) continue;
    out.push({ ...c, files });
  }
  return out;
}

/**
 * Commits for a working tree, with every path relative to `root` rather than to the repository.
 *
 * THE FOOTGUN THIS REMOVES. `gitCommits` returns what git says, and git says paths relative to
 * the REPOSITORY root — so any caller that pairs it with index-relative paths silently matches
 * nothing. `gitOwnership` handled that internally, which fixed the stored report and left every
 * OTHER caller wrong: the ownership route's reviewer query and the PR route both read commits
 * directly, and both compared repo-root paths against the index-root paths their callers pass.
 * The reviewer panel answered "nobody has history on those files" for files one person had
 * written entirely.
 *
 * Exported so the correct thing is the easy thing. `gitCommits` stays available for the two
 * callers that genuinely want repository-wide, repository-relative history.
 */
export function gitCommitsForRoot(root: string, window: GitWindow): Commit[] {
  return rebaseCommits(gitCommits(root, window), repoPathPrefix(root));
}

export interface GitOwnershipOptions {
  readonly windowDays?: number;
  /**
   * Current-tree symbols. Omit to skip the hunk pass entirely — the report then carries no
   * symbol attribution, which `symbols: []` alongside a documented limitation states honestly.
   */
  readonly symbols?: readonly SymbolSpan[];
  readonly maxHunkCommits?: number;
  /** Evaluation instant, epoch seconds. Defaults to the newest commit read. */
  readonly now?: number;
  readonly maxFiles?: number;
}

/**
 * Ownership for a working tree.
 *
 * Returns an empty report when the directory is not a git repository or git is unavailable —
 * the same failure posture as `gitSignals`. Symbol attribution is attempted only when the
 * caller supplies symbols, and its own failure (an oversized `-p` payload, most likely) costs
 * only the symbol map.
 */
export function gitOwnership(root: string, options?: GitOwnershipOptions): OwnershipReport {
  const windowDays = Math.max(1, Math.floor(options?.windowDays ?? DEFAULT_WINDOW_DAYS));
  const window: GitWindow = { since: `${windowDays}.days.ago` };
  // Everything downstream is keyed on paths relative to the ANALYSED root; git speaks in paths
  // relative to the REPOSITORY root. Rebase once, here, so no consumer has to know.
  const prefix = repoPathPrefix(root);
  const commits = rebaseCommits(gitCommits(root, window), prefix);
  const symbols = options?.symbols;
  let attribution: SymbolAttribution | null = null;
  if (symbols !== undefined && symbols.length > 0 && commits.length > 0) {
    try {
      const raw = gitHunkLog(
        root,
        window,
        options?.maxHunkCommits === undefined ? undefined : { maxCommits: options.maxHunkCommits },
      );
      // The hunk pass reports repository-root paths for the same reason the name-only pass
      // does, so it needs the same rebase — without it every range is compared against a
      // symbol span in a file whose key does not exist, and attribution is silently zero.
      const hunks = parseGitLogHunks(raw).map((c) => ({
        ...c,
        files:
          prefix === ""
            ? c.files
            : c.files
                .filter((f) => f.path.startsWith(prefix))
                .map((f) => ({ ...f, path: f.path.slice(prefix.length) })),
      }));
      attribution = symbolOwnership(hunks, symbols);
    } catch {
      // ENOBUFS on a huge payload, or no git. File-level ownership is already computed and is
      // the more useful half; losing symbols must not lose it.
      attribution = null;
    }
  }
  return ownershipReport(commits, {
    windowDays,
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    ...(attribution === null ? {} : { symbols: attribution.symbols, truncated: attribution.truncated }),
  });
}
