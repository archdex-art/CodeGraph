import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "@codegraph/config";
import { gitSignals, type FileSignals } from "@codegraph/vcs";
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
import { buildSymbolGraph, callAt, classifyTaint, contextAt, extractorFor, syntacticSpans, tierForExt } from "@codegraph/core-graph";
import type { AnalysisTier, ExtractionRecord, TaintQuery, TaintVerdict } from "@codegraph/core-graph";
import { hashText, planReuse, saveManifest } from "./incremental";
import type { ScanCoverage, ScannedFile } from "@codegraph/analysis-model";
import {
  CODE_EXTS,
  LANG_BY_EXT,
  YIELD_EVERY,
  timeStage,
  yieldToEventLoop,
  type StageTimings,
} from "@codegraph/analysis-model";
import { HITS_PER_RULE_PER_FILE, expectedHarm, scoreIssues } from "@codegraph/score-engine";
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

const MAX_FILES = config.maxFiles;
const MAX_FILE_BYTES = 400_000;

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
  /** Dropped for exceeding MAX_FILE_BYTES. */
  skippedTooLarge: number;
  /** Dropped because `stat`/`readdir` failed — permissions, races, broken links. */
  skippedUnreadable: number;
  /**
   * The MAX_FILES cap stopped the walk early.
   *
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
}

function walk(root: string): { files: string[]; coverage: WalkCoverage } {
  const out: string[] = [];
  const stack = [root];
  let filesSeen = 0;
  let skippedTooLarge = 0;
  let skippedUnreadable = 0;
  let skippedNestedRepos = 0;

  while (stack.length && out.length < MAX_FILES) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      skippedUnreadable++;
      continue;
    }
    for (const name of entries) {
      const full = path.join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        skippedUnreadable++;
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS[name] || name.startsWith(".")) continue;
        // A nested repository is a separate project. Checked on the CHILD, so the scan root's
        // own `.git` never excludes the repository we were asked to analyse — and indexing a
        // clone directly still works, because the walk starts inside it.
        if (existsSync(path.join(full, ".git"))) {
          skippedNestedRepos++;
          continue;
        }
        stack.push(full);
      } else if (st.isFile()) {
        filesSeen++;
        if (st.size <= MAX_FILE_BYTES) out.push(full);
        else skippedTooLarge++;
      }
    }
  }

  return {
    files: out,
    coverage: {
      filesSeen,
      filesKept: out.length,
      skippedTooLarge,
      skippedUnreadable,
      capHit: out.length >= MAX_FILES,
      unvisitedDirs: stack.length,
      skippedNestedRepos,
    },
  };
}

// Import extraction and resolution moved to `@codegraph/imports` (LLD §13).


/** Walk the repo, build per-file records + language stats. */
async function scan(
  root: string,
  ctx?: PipelineContext,
): Promise<{ files: ScannedFile[]; languages: LanguageStat[]; loc: number; coverage: ScanCoverage }> {
  const { files: paths, coverage: walkCoverage } = walk(root);
  let skippedNoLanguage = 0;
  const files: ScannedFile[] = [];
  const langMap = new Map<string, { files: number; loc: number }>();
  let totalLoc = 0;

  for (let idx = 0; idx < paths.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) {
      await yieldToEventLoop();
      throwIfAborted(ctx);
    }
    const full = paths[idx];
    const ext = path.extname(full).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) {
      skippedNoLanguage++;
      continue;
    }
    let text = "";
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const loc = text.length ? text.split("\n").length : 0;
    totalLoc += loc;
    const cur = langMap.get(lang) || { files: 0, loc: 0 };
    cur.files += 1;
    cur.loc += loc;
    langMap.set(lang, cur);

    files.push({
      rel: path.relative(root, full),
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
): { issues: Issue[]; count: number; depsList: string[] } {
  const issues: Issue[] = [];
  const external = new Set<string>();

  const manifests = files
    .filter((f) => path.basename(f.rel) === "package.json")
    .map((f) => f.rel)
    .sort();

  // Names declared BY manifests in this repo are workspace-internal, not dependencies. Two
  // passes so a package can be recognised as internal regardless of manifest order.
  const internal = new Set<string>();
  const parsed = new Map<string, { deps: Record<string, string>; name?: string }>();
  for (const rel of manifests) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, rel), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.name) internal.add(pkg.name);
      parsed.set(rel, {
        deps: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) },
        ...(pkg.name === undefined ? {} : { name: pkg.name }),
      });
    } catch {
      // A malformed manifest is a finding, not a crash — it breaks `npm install` too.
      issues.push(
        mkIssue("dependency_hygiene", 2, "Unparseable package.json", rel, 1, 2, 1.0),
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
          mkIssue("dependency_hygiene", 3, `Unpinned dependency: ${name} (${v})`, rel, 1, 2, 1.0),
        );
      } else if (/^[~^]?0\./.test(v)) {
        issues.push(
          mkIssue("dependency_hygiene", 1, `Pre-1.0 dependency: ${name} (${v})`, rel, 1, 1, 1.0),
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
    issues.push(mkIssue("dependency_hygiene", 2, "No lockfile committed", "package.json", 1, 2, 1.0));
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
            mkIssue("dependency_hygiene", 2, `Unpinned dependency: ${l.trim()}`, f.rel, 1, 1, 1.0),
          );
        }
      }
    } catch {
      /* unreadable — already counted by the scan's coverage */
    }
  }

  // DISTINCT external packages. The same dependency declared by six workspaces is one
  // dependency; counting declarations instead would make a monorepo look six times heavier.
  return { issues, count: external.size, depsList: [...external].sort() };
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
  const { files, languages, loc, coverage } = await timeStage(stageTimings, "scan", () =>
    scan(root, ctx),
  );
  const { fanIn, importEdges } = await timeStage(stageTimings, "imports", () =>
    computeImportGraph(files, ctx),
  );
  
  const dep = await timeStage(stageTimings, "dependencies", () => analyzeDependencies(root, files));
  const codeIssues = await timeStage(stageTimings, "detect", () =>
    analyzeFiles(files, fanIn, churnMap, ctx),
  );
  const testIssues = analyzeTests(files);
  const issues = [...codeIssues, ...dep.issues, ...testIssues];

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

  const viz = buildVizGraph(files, importEdges, fanIn, issues);
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
   * Written AFTER the graph, so a run that threw (cancelled, out of memory, a parser crash)
   * leaves the previous manifest in place rather than a half-built one describing files it
   * never finished analysing.
   */
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
