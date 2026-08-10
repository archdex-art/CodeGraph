import { readFileSync, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "@codegraph/config";
import { gitOwnership, gitSignals, gitTreeFiles, hasWorkingTree, listNonIgnoredFiles, readBlobs, type FileSignals } from "@codegraph/vcs";
import { disabledReport, fetchAdvisories, osvTransport, resolvePackages } from "./advisories";
import { findUnusedDependencies } from "./depintel";
import { throwIfAborted, type PipelineContext } from "./context";
import type {
  Dimension,
  DimensionScore,
  GraphStats,
  GraphNode,
  GraphEdge,
  LanguageStat,
  TreeNode,
  VizGraph,
  ModuleGraph,
  Issue,
  IndexResult,
  ModuleNode,
  ModuleEdge,
} from "@codegraph/analysis-model";
import type { SymbolGraph } from "@codegraph/core-graph";
import {
  DIMENSION_META,
  PILLAR_META,
  pillarsFrom,
  type PillarScore,
} from "@codegraph/analysis-model";
import { analyseTaint, buildApiSurface, buildSymbolGraph, callAt, classifyTaint, contextAt, extractEndpoints, extractorFor, syntacticSpans, tierForExt } from "@codegraph/core-graph";
import type { AnalysisTier, ExtractionRecord, TaintQuery, TaintVerdict } from "@codegraph/core-graph";
import { hashText, planReuse, saveManifest } from "./incremental";
import type { ScanCoverage, ScannedFile } from "@codegraph/analysis-model";
import {
  CODE_EXTS,
  LANG_BY_EXT,
  YIELD_EVERY,
  emitPhase,
  timeStage,
  yieldToEventLoop,
  type StageTimings,
} from "@codegraph/analysis-model";
import { HITS_PER_RULE_PER_FILE, expectedHarm, scoreIssues } from "@codegraph/score-engine";
import { applyBaseline } from "@codegraph/analysis-model";
import { BASELINE_FILE, parseBaseline } from "./baseline";
import { buildModuleGraph, buildTree, buildVizGraph } from "@codegraph/viz";
import { computeImportGraph, extractImports } from "@codegraph/imports";
import {
  analyzeFiles,
  analyzeTests,
  mkIssue,
  resetIssueIds,
} from "@codegraph/detect-engine";
import ts from "typescript";
import type { SourceContext } from "@codegraph/core-graph";



const SKIP_DIRS: Record<string, true> = {
  ".git": true, "node_modules": true, "dist": true, "build": true,
  ".next": true, "out": true, "vendor": true, "__pycache__": true,
  ".venv": true, "venv": true, "target": true, ".idea": true,
  ".vscode": true, "coverage": true,
};
/**
 * Whether the walk would refuse this repo-relative path.
 *
 * Extracted so the git-tree source and the filesystem walk cannot drift: `walk` applies
 * `SKIP_DIRS` and the leading-dot rule per directory ENTRY as it descends, which the tree
 * listing has no equivalent of - it hands over full paths, already flattened.
 *
 * DIRECTORY SEGMENTS ONLY. The walk tests those names when it decides whether to descend; a
 * FILE is never rejected for its name, so `.editorconfig` and `.npmrc` are seen, counted, and
 * fall out later as having no language. Applying the rule to the basename too made the tree
 * source report one fewer file seen than the walk on the same commit - the file sets matched,
 * but the coverage denominators did not, and the coverage denominator is what the Health
 * Score is normalised by.
 */
function isSkippedPath(rel: string): boolean {
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (!segment) continue;
    if (SKIP_DIRS[segment] || segment.startsWith(".")) return true;
  }
  return false;
}


/**
 * Issues emitted per rule per file.
 *
 * A bound on the stored/rendered issue list, NOT on the score — `volumeMultiplier`
 * accounts for matches beyond it. Conflating the two is review item B3: the cap
 * was a performance guard doing metric duty, so deleting 400 of 500 debug lines
 * moved the score by zero.
 */





/**
 * What the scan actually looked at (ADR-008).
 *
 * The walk drops files for three reasons and used to count none of them, so a score computed
 * over half a repository rendered identically to one computed over all of it. ADR-008: "a
 * score computed over 40% analysed LOC can no longer masquerade as one computed over 98%."
 */
interface WalkCoverage {
  /** Files the walk encountered, including ones it then dropped. */
  filesSeen: number;
  /**
   * Files the walk KEPT — not the number analysed.
   *
   * The scan drops more of these afterwards for having no language mapping, so naming this
   * `filesAnalysed` (as it briefly was) overstated coverage by 176 files on this repository.
   * Overstating coverage inside the coverage report is the exact failure this feature exists
   * to prevent.
   */
  filesKept: number;
  /** Dropped for exceeding `config.maxFileBytes`. */
  skippedTooLarge: number;
  /** Dropped because `stat`/`readdir` failed — permissions, races, broken links. */
  skippedUnreadable: number;
  /**
   * A boolean, not a count, and deliberately so: the cap breaks out before the remaining
   * directories are visited, so the number of files never seen is genuinely UNKNOWN. Reporting
   * an invented total would be worse than reporting that the walk was truncated — and
   * `unvisitedDirs` below bounds how much was left rather than guessing what was in it.
   */
  capHit: boolean;
  /** Directories still on the stack when the cap stopped the walk. */
  unvisitedDirs: number;
  /**
   * Nested git repositories skipped — clones, vendored checkouts, submodules.
   *
   * A directory with its own `.git` is a DIFFERENT PROJECT by git's own definition, and folding
   * it in attributes someone else's issues to this repository. Measured on CodeGraph's own
   * checkout before this existed: `apps/web/data/workspaces/` holds the repos the app has
   * indexed, and they were **54.2% of the scanned tree** and 77 of the 200 reported issues.
   * The self-index was majority foreign code.
   *
   * Counted rather than silently dropped, because "we ignored 5 nested repos" is exactly the
   * kind of thing ADR-008 says the score must disclose.
   */
  skippedNestedRepos: number;
  /**
   * Entries excluded because the project's own `.gitignore` excludes them.
   *
   * ENTRIES, not files: a wholly-ignored directory is pruned as one, because descending it to
   * count its contents is the work the prune exists to avoid. So this is a lower bound on the
   * files skipped, and is named that way rather than implying a file count it does not have.
   *
   * The fixed skip list above covers `node_modules`, `dist` and a handful of other names; it
   * cannot know what THIS project considers generated. Measured on CodeGraph's own checkout:
   * `apps/web/data/` is gitignored because it holds the running app's database and its cached
   * timeline snapshots, and the walk read 54 JSON files totalling 581,639 lines out of it —
   * against 29,368 lines of actual TypeScript in the same tree. `apps` was reported as a JSON
   * module and coloured as one, and LOC is the denominator of the Health Score, so the score
   * itself was diluted by the tool's own database.
   *
   * Counted for the same reason `skippedNestedRepos` is: ADR-008 says the score discloses what
   * it did not look at.
   */
  skippedIgnored: number;
}

function walk(root: string): { files: string[]; coverage: WalkCoverage } {
  const out: string[] = [];
  const stack = [root];
  let filesSeen = 0;
  let skippedTooLarge = 0;
  let skippedUnreadable = 0;
  let skippedNestedRepos = 0;
  let skippedIgnored = 0;
  /**
   * Both caps are read HERE, per walk, not once at module load.
   *
   * `config` is a live view over `process.env` (packages/config/src/index.ts), and
   * `const MAX_FILES = config.maxFiles` at module scope threw that away: ES imports are
   * hoisted, so the snapshot was taken before any caller — a test, an entrypoint reading a
   * `.env` — had set the variable, and `CG_MAX_FILES` was silently the default for anyone
   * who set it late. One property read per walk costs nothing next to the traversal.
   */
  const maxFiles = config.maxFiles;
  const maxFileBytes = config.maxFileBytes;

  /**
   * What the project itself considers its own files, or null when this is not a git checkout.
   *
   * Read ONCE, before the walk, so the whole traversal costs one subprocess rather than one
   * per directory. Null means no filtering: a plain folder is a supported input and has no
   * opinion to respect.
   *
   * Directory prefixes are derived from the same list so an ignored tree is PRUNED rather than
   * walked and discarded file by file — on this repository that is the difference between
   * stat-ing 600 snapshot files and never opening the directory.
   */
  const allowed = listNonIgnoredFiles(root);
  const allowedDirs = allowed === null ? null : new Set<string>();
  if (allowed !== null && allowedDirs !== null) {
    for (const rel of allowed) {
      let cut = rel.indexOf("/");
      while (cut !== -1) {
        allowedDirs.add(rel.slice(0, cut));
        cut = rel.indexOf("/", cut + 1);
      }
    }
  }
  const relOf = (full: string): string => path.relative(root, full).split(path.sep).join("/");
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      // Sorted, because the walk is CAPPED (`maxFiles`) and a cap makes traversal order
      // load-bearing: past the cap an unsorted `readdirSync` lets filesystem order decide
      // WHICH files get analysed, so the Health Score would differ between two runs over
      // identical bytes on two machines. Determinism is the product's central claim; a sort
      // on a directory listing is what makes it true at the root of the pipeline.
      entries = readdirSync(cur).sort();
    } catch {
      skippedUnreadable++;
      continue;
    }
    // Directories are collected and pushed in REVERSE, so `stack.pop()` visits them in
    // ascending name order. Files are emitted in ascending order as they are met.
    const dirs: string[] = [];
    for (const name of entries) {
      const full = path.join(cur, name);
      let st;
      try {
        /**
         * `lstatSync`, not `statSync`. A cloned repository can ship
         * `innocent.ts -> /proc/self/environ` (or `/etc/passwd`, or the deploy's `.env`), and
         * `statSync` follows it: the target was read into the pipeline, and any detector rule
         * that matched put up to 120 characters of it into a finding's `evidence` string,
         * which `GET /api/repos/:id` serves. The web process's environment carries
         * `CG_SESSION_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET` and `ANTHROPIC_API_KEY`, and the
         * secret-detection rules are exactly the ones that match an environment dump.
         *
         * The two other walkers in this codebase — `remediate-engine`'s `walkCode` and the
         * editor's `resolveSafe` — already refuse symlinks, so this closed the one path left
         * open. Skipping rather than resolving-and-checking is deliberate: a symlink inside a
         * repository is not source code the analysis needs, and its target is either already
         * in the walk or outside it.
         */
        st = lstatSync(full);
      } catch {
        skippedUnreadable++;
        continue;
      }
      if (st.isSymbolicLink()) {
        skippedUnreadable++;
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS[name] || name.startsWith(".")) continue;
        /**
         * A wholly-ignored tree is PRUNED, and — like `SKIP_DIRS` and dot-directories above —
         * counted nowhere. That is deliberate consistency, not an oversight: `filesSeen` means
         * "files the walk encountered", and a pruned tree is never entered, so its contents
         * were not encountered by anyone's definition. Counting an estimate of them would put
         * a number in the coverage report that no traversal produced.
         */
        if (allowedDirs !== null && !allowedDirs.has(relOf(full))) continue;
        // A nested repository is a separate project. Checked on the CHILD, so the scan root's
        // own `.git` never excludes the repository we were asked to analyse — and indexing a
        // clone directly still works, because the walk starts inside it.
        if (existsSync(path.join(full, ".git"))) {
          skippedNestedRepos++;
          continue;
        }
        dirs.push(full);
      } else if (st.isFile()) {
        // Seen BEFORE the ignore test: this file was encountered, and the coverage report's
        // job is to say what was there as well as what was looked at. It is then accounted for
        // in exactly one bucket, so `filesKept + skippedTooLarge + skippedIgnored` still sums
        // to `filesSeen` — the invariant `coverage.test.ts` exists to defend.
        filesSeen++;
        if (allowed !== null && !allowed.has(relOf(full))) {
          skippedIgnored++;
          continue;
        }
        if (st.size <= maxFileBytes) out.push(full);
        else skippedTooLarge++;
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]!);
  }

  return {
    files: out,
    coverage: {
      filesSeen,
      filesKept: out.length,
      skippedTooLarge,
      skippedUnreadable,
      capHit: out.length >= maxFiles,
      unvisitedDirs: stack.length,
      skippedNestedRepos,
      skippedIgnored,
    },
  };
}

// Import extraction and resolution moved to `@codegraph/imports` (LLD §13).


/**
 * One file to consider, from whichever source enumerated it.
 *
 * `read` is deferred so the size cap and the language check can reject a file before its
 * bytes are fetched - which is most of the point when the bytes come over a pipe from git.
 */
interface SourceFile {
  readonly rel: string;
  readonly ext: string;
  read(): string | null;
}

/**
 * Enumerate from git when there is no working tree, otherwise walk the filesystem.
 *
 * WHY BOTH. A local folder IS its own working tree and must be walked - it is the user's real
 * directory and may contain uncommitted work, which is the whole point of indexing it. A
 * cloned repository has no working tree by default (see `requireWorkspace`), because
 * materialising one costs 614 MB on `microsoft/TypeScript` to produce files this function
 * reads once and discards.
 *
 * `git ls-tree -r -l` answers "which paths, and how big" for 81,368 entries in 0.1s without
 * touching the filesystem, and tracked-only is the gitignore-correct set for free - the
 * separate `git ls-files` pass the walker needs for the same answer.
 */
function enumerate(root: string): { entries: SourceFile[]; coverage: WalkCoverage } {
  const tree = hasWorkingTree(root) ? null : gitTreeFiles(root);
  if (tree === null) {
    const { files: paths, coverage } = walk(root);
    return {
      coverage,
      entries: paths.map((full) => ({
        rel: path.relative(root, full),
        ext: path.extname(full).toLowerCase(),
        read: () => {
          try {
            return readFileSync(full, "utf8");
          } catch {
            return null;
          }
        },
      })),
    };
  }

  /*
   * The cap is applied while iterating, not after, so `filesSeen` counts what was CONSIDERED
   * rather than what exists. The filesystem walk stops at the cap and reports the same way,
   * and `coverage.test.ts` asserts `filesKept + skippedTooLarge + skippedIgnored === filesSeen`
   * - an invariant that breaks the moment one source counts the whole tree and the other
   * counts a prefix of it.
   */
  let filesSeen = 0;
  let skippedTooLarge = 0;
  const wanted: Array<{ rel: string; ext: string; oid: string }> = [];
  for (const entry of tree) {
    if (wanted.length >= config.maxFiles) break;
    /*
     * THE SAME SKIP RULES THE WALK APPLIES, or the two sources disagree about the repository.
     *
     * Measured on `sindresorhus/slugify` before this existed: the walk reported 6 files and
     * 1,068 LOC, the tree reported 8 and 1,094, because `ls-tree` lists dotfiles and the
     * contents of `vendor/`, `dist/` and friends while the walk skips both. A Health Score
     * that changes with how the repository was ACQUIRED is not a measurement of the
     * repository, so the rule lives in `isSkippedPath` and both callers use it.
     */
    if (isSkippedPath(entry.path)) continue;
    filesSeen++;
    if (entry.size > config.maxFileBytes) {
      skippedTooLarge++;
      continue;
    }
    wanted.push({ rel: entry.path, ext: path.extname(entry.path).toLowerCase(), oid: entry.oid });
  }

  const blobs = readBlobs(root, wanted.map((w) => w.oid));
  return {
    coverage: {
      filesSeen,
      filesKept: wanted.length,
      skippedTooLarge,
      // Nothing was READ and rejected: git either has the object or the listing would not
      // have named it. A blob that fails to come back is counted at the read below.
      skippedUnreadable: 0,
      // Submodules never reach here - `gitTreeFiles` drops non-blob entries - so there is no
      // nested repository to skip rather than one being silently swallowed.
      skippedNestedRepos: 0,
      // An ignored file is not listed by `ls-tree` at all, so it was never SEEN. Reporting it
      // as skipped would invent a number the tree cannot supply.
      skippedIgnored: 0,
      capHit: wanted.length >= config.maxFiles,
      // A count, not a flag: the walk reports how many directories it never entered. Reading
      // the whole tree from git leaves none unvisited, which is a real zero.
      unvisitedDirs: 0,
    },
    entries: wanted.map((w) => ({ rel: w.rel, ext: w.ext, read: () => blobs.get(w.oid) ?? null })),
  };
}

/** Enumerate the repo, build per-file records + language stats. */
async function scan(
  root: string,
  ctx?: PipelineContext,
): Promise<{ files: ScannedFile[]; languages: LanguageStat[]; loc: number; coverage: ScanCoverage }> {
  const { entries, coverage: walkCoverage } = enumerate(root);
  let skippedNoLanguage = 0;
  const files: ScannedFile[] = [];
  const langMap = new Map<string, { files: number; loc: number }>();
  let totalLoc = 0;

  for (let idx = 0; idx < entries.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) {
      await yieldToEventLoop();
      throwIfAborted(ctx);
      // The yield point is the only place a stage may do anything besides its own work,
      // so it is also where progress is reported. Coalesced by the caller's sink.
      emitPhase(ctx, "scan", idx, entries.length);
    }
    const { rel, ext } = entries[idx]!;
    const lang = LANG_BY_EXT[ext];
    if (!lang) {
      skippedNoLanguage++;
      continue;
    }
    const text = entries[idx]!.read();
    if (text === null) continue;
    const loc = text.length ? text.split("\n").length : 0;
    totalLoc += loc;
    const cur = langMap.get(lang) || { files: 0, loc: 0 };
    cur.files += 1;
    cur.loc += loc;
    langMap.set(lang, cur);

    files.push({
      rel,
      ext,
      loc,
      // Hashed BEFORE the `CODE_EXTS` gate below discards the text for non-code files, so
      // every scanned file has an identity the incremental planner can compare — including
      // the manifests and lockfiles whose changes force a full rebuild.
      hash: hashText(text),
      text: CODE_EXTS[ext] ? text : "",
      imports: extractImports(text, ext),
    });
  }

  const languages = [...langMap.entries()]
    .map(([language, v]) => ({ language, ...v }))
    .sort((a, b) => b.loc - a.loc);

  /**
   * LOC by analysis tier (HLD §8.3), so "% of LOC at tier >= ast" is derivable. A repository
   * that is mostly Python should say it was regex-scanned rather than score as though it had
   * been parsed.
   */
  const tierLoc: Partial<Record<AnalysisTier, number>> = {};
  for (const f of files) {
    const t = tierForExt(f.ext);
    tierLoc[t] = (tierLoc[t] ?? 0) + f.loc;
  }

  return {
    files,
    languages,
    loc: totalLoc,
    coverage: {
      ...walkCoverage,
      skippedNoLanguage,
      locAnalysed: totalLoc,
      filesAnalysed: walkCoverage.filesKept - skippedNoLanguage,
      tierLoc,
    },
  };
}




// The module-level architecture graph moved to `@codegraph/viz` (LLD §13): it is display
// structure, the same category as `buildVizGraph` and `buildTree`.


/**
 * Dependency hygiene. Stays in the pipeline rather than `detect-engine` because it READS
 * package.json from disk, and the layering rule confines raw `fs` to the I/O packages. The
 * dependency-cruiser gate caught this the moment it moved - the slice boundary was wrong, not
 * the rule. Separating its file read from its rule logic is what would let it join the others.
 */
/**
 * Dependency hygiene across EVERY manifest in the repo, not just the root one.
 *
 * THE BUG THIS FIXES. This read `path.join(root, "package.json")` and nothing else. On a
 * workspaces monorepo that is the thinnest manifest in the tree: measured on CodeGraph itself,
 * the root declares 3 dependencies while the 18 workspace manifests declare 36 distinct
 * external packages between them. So 33 of 36 dependencies — including every runtime one the
 * product actually ships — were invisible to dependency hygiene, and the dimension scored a
 * clean 100 over 3 packages.
 *
 * Manifests come from the ALREADY-SCANNED file list rather than a second filesystem walk, so
 * this costs nothing and — the part that matters — it inherits the walk's exclusions. That
 * includes `node_modules` and nested git repositories, without which this would happily report
 * a cloned target repository's dependencies as this project's own. Five such clones were
 * present in this checkout while the fix was written.
 */
function analyzeDependencies(
  root: string,
  files: readonly ScannedFile[],
): {
  issues: Issue[];
  count: number;
  depsList: string[];
  /**
   * Declarations with their SCOPE preserved, for unused-dependency analysis.
   *
   * `depsList` above flattens `dependencies` and `devDependencies` together, which is right
   * for "what does this repo depend on" and wrong for "is this unused": a dev dependency that
   * nothing imports is usually a CLI run from `scripts`, and a peer dependency is imported by
   * the consumer rather than by us. Same parse, one extra shape, rather than a second read of
   * every manifest.
   */
  declared: Array<{ name: string; manifest: string; scope: string }>;
  /** `scripts` from every manifest, keyed `<manifest>:<script>`, for the same analysis. */
  scripts: Map<string, string>;
  /**
   * Names THIS repository's own manifests declare — what it publishes, not what it consumes.
   *
   * Already computed as `internal` for the workspace-sibling check below; returned because it
   * is the only evidence that can make a repository the TARGET of a cross-repo dependency
   * edge. The alternative — matching a dependency against a repository's slug — invents a link
   * whenever two things share a word.
   */
  packageNames: string[];
} {
  const issues: Issue[] = [];
  const external = new Set<string>();

  const manifests = files
    .filter((f) => path.basename(f.rel) === "package.json")
    .map((f) => f.rel)
    .sort();

  // Names declared BY manifests in this repo are workspace-internal, not dependencies. Two
  // passes so a package can be recognised as internal regardless of manifest order.
  const internal = new Set<string>();
  const parsed = new Map<string, { deps: Record<string, string>; name?: string; private?: boolean }>();
  // Collected in the SAME pass, not a second read of every manifest.
  const declared: Array<{ name: string; manifest: string; scope: string }> = [];
  const scripts = new Map<string, string>();
  const SCOPES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
  for (const rel of manifests) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, rel), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        private?: boolean;
      };
      if (pkg.name) internal.add(pkg.name);
      parsed.set(rel, {
        deps: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) },
        ...(pkg.name === undefined ? {} : { name: pkg.name }),
        ...(pkg.private === undefined ? {} : { private: pkg.private }),
      });
      for (const scope of SCOPES) {
        for (const name of Object.keys(pkg[scope] ?? {})) declared.push({ name, manifest: rel, scope });
      }
      for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
        if (typeof command === "string") scripts.set(`${rel}:${script}`, command);
      }
    } catch {
      // A malformed manifest is a finding, not a crash — it breaks `npm install` too.
      issues.push(
        mkIssue("unparseable-manifest", "dependency_hygiene", 2, "Unparseable package.json", rel, 1, 2, 1.0, 1, "JSON.parse failed — `npm install` fails on this too"),
      );
    }
  }

  for (const [rel, pkg] of parsed) {
    for (const [name, range] of Object.entries(pkg.deps)) {
      // A workspace depending on a sibling is structure, not supply chain.
      if (internal.has(name)) continue;
      external.add(name);
      const v = String(range);
      // `*` is how workspace protocols are often written; only flag it for externals, which
      // is why this sits after the `internal` check.
      if (v === "*" || v === "latest" || v.startsWith("http") || v.startsWith("git")) {
        issues.push(
          mkIssue("unpinned-dependency", "dependency_hygiene", 3, `Unpinned dependency: ${name} (${v})`, rel, 1, 2, 1.0, 1, `range \`${v}\` resolves to whatever is published at install time`),
        );
      } else if (/^[~^]?0\./.test(v)) {
        issues.push(
          mkIssue("pre-1.0-dependency", "dependency_hygiene", 1, `Pre-1.0 dependency: ${name} (${v})`, rel, 1, 1, 1.0, 1, `range \`${v}\` — semver makes no compatibility promise below 1.0`),
        );
      }
    }
  }

  // The lockfile check stays at the ROOT. In a workspaces repo one root lockfile covers every
  // member, so requiring one per manifest would report a problem that does not exist.
  if (
    manifests.length > 0 &&
    !existsSync(path.join(root, "package-lock.json")) &&
    !existsSync(path.join(root, "pnpm-lock.yaml")) &&
    !existsSync(path.join(root, "yarn.lock"))
  ) {
    /**
     * A PUBLISHED LIBRARY is a different case, and reporting it identically was noise.
     * npm never ships a lockfile to consumers, so for a package whose product is the tarball
     * the file pins nothing for anybody but its own CI — plenty of well-run libraries omit it
     * deliberately. An application's lockfile IS its install contract. Same finding, honest
     * confidence: certain for an app, a judgement call for a library.
     */
    const rootPkg = parsed.get("package.json");
    const library = rootPkg !== undefined && rootPkg.name !== undefined && !rootPkg.private;
    issues.push(
      mkIssue(
        "no-lockfile",
        "dependency_hygiene",
        2,
        "No lockfile committed",
        "package.json",
        1,
        2,
        library ? 0.4 : 1.0,
        1,
        library
          ? "published library — a lockfile is never shipped to consumers, so this is a CI-reproducibility choice"
          : "application — installs are not reproducible without one",
      ),
    );
  }

  // Python, same treatment: every requirements.txt the scan found.
  for (const f of files) {
    if (path.basename(f.rel) !== "requirements.txt") continue;
    try {
      const lines = readFileSync(path.join(root, f.rel), "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"));
      for (const l of lines) {
        const m = l.match(/^([A-Za-z0-9_.-]+)/);
        if (m?.[1]) external.add(m[1]);
        if (!/[=<>~]/.test(l)) {
          issues.push(
            mkIssue("unpinned-dependency", "dependency_hygiene", 2, `Unpinned dependency: ${l.trim()}`, f.rel, 1, 1, 1.0, 1, "no version specifier — installs the latest release"),
          );
        }
      }
    } catch {
      /* unreadable — already counted by the scan's coverage */
    }
  }

  // DISTINCT external packages. The same dependency declared by six workspaces is one
  // dependency; counting declarations instead would make a monorepo look six times heavier.
  return {
    issues,
    count: external.size,
    depsList: [...external].sort(),
    declared,
    scripts,
    packageNames: [...internal].sort(),
  };
}

/** Full pipeline: scan a repo/folder dir → result (graph + score + viz). */
export async function indexRepo(root: string, ctx?: PipelineContext): Promise<IndexResult> {
  resetIssueIds();
  /**
   * One git pass yields eight organisational signals, not just churn (PLAN.md §5.2).
   *
   * Of the eight, only `churn` currently has a consumer. The other seven are returned and
   * unread: they were built for the calibration ADR-009 deleted. They stay because they cost
   * nothing extra here - this pass runs for `churn` regardless - but PLAN.md §5.2 records the
   * condition on which they stay, and it is not "they are already written".
   *
   * `churnMap` is derived from the same pass rather than costing a second one, so this
   * replaces the old `churnByFile()` call at equal cost. The other seven signals are REPORTED,
   * NOT SCORED — see `signals` in the result below.
   */
  const signalMap = gitSignals(root);
  const churnMap = new Map<string, number>();
  for (const [file, sig] of signalMap) churnMap.set(file, sig.churn);
  /**
   * Stage timings (HLD §14). Named for the stages LLD §13 split out, so a slow run points at a
   * package rather than at "indexing".
   */
  const stageTimings: StageTimings = {};
  // Emitted OUTSIDE `timeStage`, before each stage opens, so a stage's recorded duration
  // stays the duration of the stage and not of the stage plus somebody's database write.
  emitPhase(ctx, "scan");
  const { files, languages, loc, coverage } = await timeStage(stageTimings, "scan", () =>
    scan(root, ctx),
  );
  emitPhase(ctx, "imports");
  const { fanIn, importEdges, externalEdges } = await timeStage(stageTimings, "imports", () =>
    computeImportGraph(files, ctx),
  );

  emitPhase(ctx, "dependencies");
  const dep = await timeStage(stageTimings, "dependencies", () => analyzeDependencies(root, files));
  emitPhase(ctx, "detect");
  const codeIssues = await timeStage(stageTimings, "detect", () =>
    analyzeFiles(files, fanIn, churnMap, ctx),
  );
  const testIssues = analyzeTests(files);
  /**
   * `.codegraph-baseline.json` marks findings the repository has already looked at and
   * accepted. Applied HERE, once, between detection and scoring: the detector stays a pure
   * function of a file's bytes (it is content-cached), and everything downstream — score,
   * ordering, SARIF, the CI gate — sees the same accepted flags without each having to read
   * the file and agree on the rules.
   */
  const baselineFile = path.join(root, BASELINE_FILE);
  // Absent is the normal case and says nothing. Unreadable or malformed degrades to "no
  // baseline" rather than to a half-applied one — see `parseBaseline`.
  const baseline = existsSync(baselineFile) ? parseBaseline(readFileSync(baselineFile, "utf8")) : null;
  const issues = applyBaseline([...codeIssues, ...dep.issues, ...testIssues], baseline);

  const dirCount = new Set(
    files.map((f) => path.posix.dirname(f.rel.split(path.sep).join("/")))
  ).size;
  const graphStats: GraphStats = {
    files: files.length,
    dirs: dirCount,
    dependencies: dep.count,
    nodes: files.length + dirCount + dep.count,
    edges: importEdges.length + files.length, // imports + containment
  };

  emitPhase(ctx, "score");
  const { dimensions, overall } = await timeStage(stageTimings, "score", () =>
    scoreIssues(issues, loc),
  );
  // Same weighting as the score - literally the same function - so the order the user reads
  // matches the weighting the score applied. Sorting by the raw `severity × blastRadius`
  // product was review item B2 surfacing a second time: it put a TODO in a heavily-imported
  // file above an eval() in a leaf.
  issues.sort((a, b) => expectedHarm(b) - expectedHarm(a));

  // Per-file issue counts (shared by viz, tree, modules).
  const issuesByFile = new Map<string, number>();
  for (const i of issues) issuesByFile.set(i.file, (issuesByFile.get(i.file) || 0) + 1);

  const viz = buildVizGraph(files, importEdges, fanIn, issues, externalEdges);
  const tree = buildTree(files, issuesByFile);
  const modules = buildModuleGraph(files, importEdges, issuesByFile);

  /**
   * Symbol-level knowledge graph (code intelligence layer), and the one stage that reuses
   * work from the previous run.
   *
   * The plan is computed here rather than at the top of the pipeline because it needs the
   * scanned file set (hashes, texts, coverage) — and because everything above it is cheap
   * enough that reusing it would be optimising the wrong stage.
   */
  const plan = planReuse({ root: path.resolve(root), files, capHit: coverage.capHit, cache: ctx?.cache });
  const extraction = new Map<string, ExtractionRecord>();
  emitPhase(ctx, "symbol-graph");
  const symbolGraph = await timeStage(stageTimings, "symbol-graph", () =>
    buildSymbolGraph(
    files
      .filter((f) => f.text && extractorFor(f.ext))
      .map((f) => ({
        rel: f.rel.split(path.sep).join("/"),
        ext: f.ext,
        text: f.text,
        language: LANG_BY_EXT[f.ext] || "unknown",
      })),
    issuesByFile,
    // The repo root, so the TS program resolves against real paths - which also gets
    // `node_modules` and `@types` in scope. Without it resolution falls back to a synthetic
    // base that only knows the files handed in.
    root,
    // A full plan passes an empty reuse map, which `buildSymbolGraph` reads as "extract
    // everything" — so the incremental path collapses onto the original one rather than
    // branching around it. There is one code path here, not two.
    { reuse: plan.reuse, invalidated: plan.full ? undefined : plan.invalidated, out: extraction },
    ),
  );

  /**
   * Ownership, staleness and symbol-level attribution.
   *
   * AFTER the symbol graph on purpose: attributing a commit to a SYMBOL means intersecting the
   * commit's changed line ranges with symbol spans, so the spans have to exist first. File and
   * author level ownership needs none of that, but splitting the two would mean two passes
   * over the same history for one report.
   *
   * This is the second `git log` of the run — `gitSignals` above is the first — because the
   * two need different payloads: signals need `--name-only`, and hunk attribution needs
   * `-p --unified=0`, which is orders of magnitude larger. Reading the big one always, to
   * serve the cheap one too, would tax every index for a feature not every caller wants.
   * `gitOwnership` bounds the hunk pass by commit count and output size, and degrades to a
   * report with empty `symbols` rather than failing the index when it hits either.
   *
   * Never throws: a non-git directory, a shallow clone with no history, or an unavailable
   * `git` all produce an EMPTY report, which is a different value from `undefined` — absent
   * means the run predates this analysis, empty means we looked and there was nothing.
   */
  emitPhase(ctx, "ownership");
  const ownership = await timeStage(stageTimings, "ownership", async () =>
    gitOwnership(root, {
      symbols: symbolGraph.symbols.map((s) => ({
        id: s.id,
        file: s.file,
        line: s.line,
        endLine: s.endLine,
      })),
    }),
  );

  /**
   * The file set both the API extractor and the taint analysis read.
   *
   * Built once and shared: it is the same projection `buildSymbolGraph` was given above, and
   * materialising it twice would mean two copies of every file's text alive at once on a host
   * whose memory ceiling is the reason analysis runs out of process at all.
   */
  const analysedSources = files
    .filter((f) => f.text && extractorFor(f.ext))
    .map((f) => ({
      rel: f.rel.split(path.sep).join("/"),
      ext: f.ext,
      text: f.text,
      language: LANG_BY_EXT[f.ext] || "unknown",
    }));

  /**
   * APIs as first-class entities, plus endpoint → service → sink data-flow tracing.
   *
   * Extraction is syntactic; `buildApiSurface` then RECONCILES each synthesised handler id
   * against real symbols, so a consumer reads `surface.endpoints` rather than the raw
   * extraction. `authenticated` is three-valued on purpose — `null` means the handler could
   * not be resolved, which is a different statement from "this endpoint has no guard", and
   * only the latter belongs in a security finding.
   */
  emitPhase(ctx, "api-surface");
  const apiSurface = await timeStage(stageTimings, "api-surface", async () =>
    buildApiSurface(extractEndpoints(analysedSources), symbolGraph),
  );

  /**
   * Inter-procedural taint: which untrusted values actually REACH a dangerous sink.
   *
   * Distinct from the API flows above, which answer "what does this endpoint touch". This
   * follows the value — argument index to parameter index across resolved call edges — so a
   * path here is a claim about data, not about reachability. A defended path is reported with
   * `sanitized: true` rather than dropped, because "we checked and it is guarded" is worth
   * more to a reader than silence.
   */
  emitPhase(ctx, "taint");
  const taint = await timeStage(stageTimings, "taint", async () =>
    analyseTaint(analysedSources, symbolGraph),
  );

  /**
   * Declared dependencies nothing imports.
   *
   * Candidates with a derived confidence, never verdicts: a linter plugin named only in a
   * config file and a CLI invoked from `scripts` are both "never imported" and both used.
   * The config-file list is taken from the scanned tree rather than guessed, so a repo that
   * has no eslint config does not get eslint plugins excused.
   *
   * WORKSPACE SIBLINGS ARE EXCLUDED, and leaving them in was a real false-positive class
   * rather than a hypothetical one. `depsList` is the EXTERNAL dependency set — it drops
   * workspace-internal names, because a package depending on its sibling is structure and not
   * supply chain — so passing the full declaration list against it made every internal
   * `@codegraph/*` dependency look unimported. Measured on this repository: 70 candidates, all
   * of them wrong, every one at the highest confidence the module can emit. A checker that
   * confident and that wrong is worse than no checker, so the filter is applied here where the
   * internal set is known rather than left to a heuristic downstream.
   */
  const internalNames = new Set(dep.packageNames);
  const unusedDependencies = findUnusedDependencies({
    declared: dep.declared.filter((d) => !internalNames.has(d.name)),
    importedPackages: new Set(dep.depsList),
    manifestScripts: dep.scripts,
    configFiles: files.map((f) => f.rel.split(path.sep).join("/")),
  });

  /**
   * Dependency vulnerabilities.
   *
   * OFF unless the operator opted in, because indexing runs on repositories a stranger
   * submitted and turning it on means an outbound request derived from that stranger's
   * manifest on every index. Off yields `status: "disabled"`, never an empty `checked` — the
   * whole point of the discriminant is that "we did not look" cannot render as "clean".
   *
   * A failure inside the lookup is caught to `unavailable` rather than failing the index: a
   * vulnerability feed being down is not a reason to lose the analysis.
   */
  emitPhase(ctx, "advisories");
  const advisories = await timeStage(stageTimings, "advisories", async () => {
    if (!config.enableAdvisoryLookup) {
      return disabledReport("CG_ENABLE_ADVISORY_LOOKUP is not set — no advisory database was queried");
    }
    try {
      return await fetchAdvisories(resolvePackages(root), osvTransport());
    } catch (e) {
      return {
        status: "unavailable" as const,
        reason: `advisory lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        advisories: [],
        packagesQueried: 0,
        checkedAt: null,
      };
    }
  });

  /**
   * Written AFTER the graph, so a run that threw (cancelled, out of memory, a parser crash)
   * leaves the previous manifest in place rather than a half-built one describing files it
   * never finished analysing.
   */
  emitPhase(ctx, "cache-write");
  const cacheWritten = await timeStage(stageTimings, "cache-write", () =>
    saveManifest({
      root: path.resolve(root),
      files,
      extraction,
      capHit: coverage.capHit,
      cache: ctx?.cache,
    }),
  );

  return {
    loc,
    languages,
    stageTimings,
    graphStats,
    dimensions,
    coverage,
    issues: issues.slice(0, 200),
    dependencies: dep.depsList,
    churnByFile: Object.fromEntries(churnMap),
    /**
     * Organisational signals (PLAN.md §5.2), reported and deliberately NOT scored.
     *
     * Weighting these by hand would add eight more hand-picked constants to a model whose
     * stated problem is that its one constant was hand-picked. §5.3 fits them against a
     * labelled defect corpus and ships the learned weights; until then they are measurements.
     */
    signals: Object.fromEntries(signalMap),
    ownership,
    apiSurface,
    taint,
    unusedDependencies,
    packageNames: dep.packageNames,
    advisories,
    score: overall,
    viz,
    tree,
    modules,
    symbolGraph,
    incremental: {
      mode: plan.full ? "full" : "incremental",
      reason: plan.reason,
      filesTotal: files.length,
      filesChanged: plan.changed,
      // Counted over the files that actually HAVE an extraction, not as
      // `extraction.size - invalidated.size`: the invalidated set also contains files no
      // extractor handles (a changed .json, say), so the subtraction understates reuse and
      // can even go negative. A reuse metric that lies is worse than no metric.
      filesReused: plan.full
        ? 0
        : [...extraction.keys()].filter((rel) => !plan.invalidated.has(rel)).length,
      cacheWritten,
    },
  };
}

/**
 * Re-export shim (LLD §13.1 step 1, §13.2).
 *
 * `cloneRepo`, `resolveLocalDir`, `cleanup`, and the churn scan now live in
 * `@codegraph/vcs` — they shell out to git, which §10.2 makes that package's
 * exclusive job, and `apps/worker` needs them without importing `apps/web`.
 * Existing importers keep working through these names; the shim is deleted in
 * §13.1 step 3 once none remain.
 */
export { cleanup, cloneRepo, resolveLocalDir } from "@codegraph/vcs";
