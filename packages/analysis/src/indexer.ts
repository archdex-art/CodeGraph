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
import type { AnalysisTier, TaintQuery, TaintVerdict } from "@codegraph/core-graph";
import type { ScanCoverage } from "@codegraph/analysis-model";
import ts from "typescript";
import type { SourceContext } from "@codegraph/core-graph";
import { lintForSecurity } from "./eslintSecurity";

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go",
  ".rs": "Rust", ".java": "Java", ".rb": "Ruby", ".php": "PHP", ".c": "C",
  ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".swift": "Swift",
  ".kt": "Kotlin", ".scala": "Scala", ".sh": "Shell", ".sql": "SQL",
  ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".md": "Markdown",
  ".json": "JSON", ".yml": "YAML", ".yaml": "YAML",
};

const CODE_EXTS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true,
  ".cjs": true, ".py": true, ".go": true, ".rs": true, ".java": true,
  ".rb": true, ".php": true, ".c": true, ".h": true, ".cpp": true,
  ".hpp": true, ".cs": true, ".swift": true, ".kt": true,
};

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
const HITS_PER_RULE_PER_FILE = 5;


interface ScannedFile {
  rel: string;
  ext: string;
  loc: number;
  text: string;
  imports: string[]; // resolved-ish relative targets
}



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

function extractImports(text: string, ext: string): string[] {
  const imports: string[] = [];

  // Go: `import "pkg/path"` and grouped `import ( "a" \n alias "b" )`.
  if (ext === ".go") {
    const block = /import\s*\(([\s\S]*?)\)/g;
    let bm;
    while ((bm = block.exec(text))) {
      const sre = /"([^"]+)"/g;
      let sm;
      while ((sm = sre.exec(bm[1]))) imports.push(sm[1]);
    }
    const single = /import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/g;
    let sm;
    while ((sm = single.exec(text))) imports.push(sm[1]);
    return imports;
  }

  // Python: `import a.b.c`, `from a.b import c, d`, and relative `from .m import x`.
  if (ext === ".py") {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.split("#")[0];
      let m;
      if ((m = /^\s*from\s+(\.*[A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line))) {
        const base = m[1];
        imports.push(base);
        for (const part of m[2].split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0].trim().replace(/[()]/g, "");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            imports.push(base.endsWith(".") || base === "" ? base + name : base + "." + name);
          }
        }
      } else if ((m = /^\s*import\s+(.+)$/.exec(line))) {
        for (const part of m[1].split(",")) {
          const mod = part.trim().split(/\s+as\s+/)[0].trim();
          if (mod) imports.push(mod);
        }
      }
    }
    return imports;
  }

  // JS/TS (and other C-family): relative specifiers, resolved against the file dir.
  if (CODE_EXTS[ext]) {
    const re = /(?:import\s+[^'"]*from\s+|require\(\s*|import\s*\(\s*|from\s+)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1].startsWith(".")) imports.push(m[1]);
    }
  }
  return imports;
}

// Every CPU-bound per-file loop below yields back to the event loop every
// YIELD_EVERY files. Without this, indexRepo() runs as one long synchronous
// call — on a large repo (thousands of files, TS type-checking, ESLint AST
// parsing per file) that can block the whole Node process for tens of
// seconds, during which NOTHING else can be served: not the dashboard, not
// other API routes, not even Render's health check -- which is exactly what
// produces the "stuck on an old page, then 502 Bad Gateway" symptom on a
// large first-time index. Yielding periodically lets the event loop drain
// other pending requests between chunks of indexing work.
const YIELD_EVERY = 15;
function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

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

/** Resolve import edges between scanned files + fan-in centrality. */
interface ImportGraph {
  fanIn: Map<string, number>;
  importEdges: Array<{ from: string; to: string }>;
}
async function computeImportGraph(files: ScannedFile[], ctx?: PipelineContext): Promise<ImportGraph> {
  const toPosix = (r: string) => r.split(path.sep).join("/");
  const byNoExt = new Map<string, string>();      // JS/TS: path (with/without ext) -> rel
  const goDirs = new Map<string, string[]>();       // Go: repo dir -> .go files in it
  const pyByDotted = new Map<string, string>();     // Python: dotted module -> rel

  for (const f of files) {
    const rel = toPosix(f.rel);
    const noExt = rel.replace(/\.[^./]+$/, "");
    byNoExt.set(noExt, f.rel);
    byNoExt.set(rel, f.rel);

    if (f.ext === ".go") {
      const dir = path.posix.dirname(rel);
      (goDirs.get(dir) ?? goDirs.set(dir, []).get(dir)!).push(f.rel);
    } else if (f.ext === ".py") {
      if (path.posix.basename(noExt) === "__init__") {
        const pkg = path.posix.dirname(rel).split("/").filter(Boolean).join(".");
        if (pkg) pyByDotted.set(pkg, f.rel);
      } else {
        pyByDotted.set(noExt.split("/").filter(Boolean).join("."), f.rel);
      }
    }
  }

  const fanIn = new Map<string, number>();
  const importEdges: Array<{ from: string; to: string }> = [];
  const link = (from: string, to: string) => {
    if (to && to !== from) {
      fanIn.set(to, (fanIn.get(to) || 0) + 1);
      importEdges.push({ from, to });
    }
  };

  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) {
      await yieldToEventLoop();
      throwIfAborted(ctx);
    }
    const f = files[idx];
    const rel = toPosix(f.rel);
    const dir = path.posix.dirname(rel);

    for (const imp of f.imports) {
      if (f.ext === ".go") {
        // Local Go imports share the repo's module prefix; match the longest
        // trailing path segment run against an actual repo directory.
        const segs = imp.split("/").filter(Boolean);
        for (let k = Math.min(segs.length, 8); k >= 1; k--) {
          const suffix = segs.slice(segs.length - k).join("/");
          const pkgFiles = goDirs.get(suffix);
          if (pkgFiles && suffix !== dir) {
            for (const target of pkgFiles) link(f.rel, target);
            break;
          }
        }
      } else if (f.ext === ".py") {
        let target: string | undefined;
        if (imp.startsWith(".")) {
          const m = /^(\.+)(.*)$/.exec(imp)!;
          const baseParts = dir.split("/").filter(Boolean);
          const upParts = baseParts.slice(0, Math.max(0, baseParts.length - (m[1].length - 1)));
          const full = [...upParts, ...m[2].split(".").filter(Boolean)].join(".");
          target = pyByDotted.get(full);
        } else {
          target = pyByDotted.get(imp);
        }
        if (target) link(f.rel, target);
      } else {
        // JS/TS relative import.
        const t = path.posix.normalize(path.posix.join(dir, imp)).replace(/^\.\//, "");
        const cand = byNoExt.get(t) || byNoExt.get(t + "/index") || byNoExt.get(t.replace(/\/$/, ""));
        if (cand) link(f.rel, cand);
      }
    }
  }
  return { fanIn, importEdges };
}


interface Rule {
  re: RegExp;
  dimension: Dimension;
  severity: number;
  confidence?: number;
  title: string;
  exts?: Record<string, true>;
  validate?: (line: string, m: RegExpExecArray) => boolean;
  /**
   * Syntactic contexts in which this rule can legitimately fire. Defaults to `["code"]`.
   *
   * This is the cheap half of PLAN.md P5's "route the regexes through structural rules": not a
   * graph-shape query yet, but the position class the match must be in. Measured across every
   * match, **35% on express and 64% on this repository** were in a context where the rule
   * cannot be true - `eval(` inside a doc comment, `console.log` inside a string.
   *
   * It is per-rule and NOT "strip comments and strings", because the correct context differs:
   * a `TODO` marker belongs in a comment and is noise anywhere else; `@ts-ignore` can only
   * ever be a comment; a hardcoded `localhost` URL is necessarily a string literal. Blanket
   * stripping would have deleted three rules' true positives outright.
   */
  context?: readonly SourceContext[];
}

const DEFAULT_CONTEXT: readonly SourceContext[] = ["code"];

// A real secret never contains a literal "..." ellipsis or matches a common
// placeholder word — those are documentation/example conventions.
const PLACEHOLDER_SECRET_RE = /^(\.{3,}|x{4,}|\*{4,}|your[-_ ]?\w*|example\w*|placeholder\w*|changeme|insert[-_ ]?\w*|redacted|dummy|fake|sample|todo|<.*>|\{\{.*\}\})$/i;
function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRET_RE.test(value) || value.includes("...");
}

// Heuristic, language-agnostic-ish defect/risk rules.
const RULES: Rule[] = [
  { re: /\beval\s*\(/, dimension: "security", severity: 5, confidence: 0.95, title: "Use of eval()" },
  { re: /child_process|os\.system\(|subprocess\.(call|run|Popen)\(/, dimension: "security", severity: 3, confidence: 0.85, title: "Shell/process execution" },
  {
    re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"]([^'"]{6,})['"]/i,
    dimension: "security", severity: 5, confidence: 0.8, title: "Possible hardcoded secret",
    validate: (_line, m) => !isPlaceholderSecret(m[2]),
  },
  // A hardcoded URL IS a string literal; in a comment it is an example, not a config value.
  { re: /https?:\/\/[^"'\s]*(?<![\w.])(localhost|127\.0\.0\.1)/, dimension: "security", severity: 2, confidence: 0.9, title: "Hardcoded local URL", context: ["string", "code"] },
  { re: /\bdangerouslySetInnerHTML\b|innerHTML\s*=/, dimension: "security", severity: 3, confidence: 0.95, title: "Raw HTML injection sink" },
  // The SELECT half matches inside the query string; the `query(` half matches in code.
  { re: /SELECT\s+.+\+|query\(\s*['"`].*\$\{/i, dimension: "security", severity: 4, confidence: 0.7, title: "Possible SQL string concatenation", context: ["code", "string"] },

  { re: /\bconsole\.(log|debug)\b|^\s*print\(/m, dimension: "correctness", severity: 1, confidence: 1.0, title: "Leftover debug output" },
  { re: /\bdebugger\b/, dimension: "correctness", severity: 2, confidence: 1.0, title: "debugger statement" },
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/, dimension: "correctness", severity: 3, confidence: 0.9, title: "Empty catch block" },
  // A marker lives in a comment BY DEFINITION. "TODO" in a string is a message, not debt.
  { re: /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/, dimension: "maintainability", severity: 1, confidence: 1.0, title: "TODO/FIXME marker", context: ["comment"] },
  // A suppression directive is only a suppression when the compiler reads it - i.e. a comment.
  { re: /@ts-(ignore|nocheck)|# type: ignore|eslint-disable/, dimension: "maintainability", severity: 2, confidence: 1.0, title: "Suppressed checker", context: ["comment"] },
  { re: /:\s*any\b|\bas\s+any\b/, dimension: "correctness", severity: 1, confidence: 1.0, title: "Untyped `any`", exts: { ".ts": true, ".tsx": true } },
];

/**
 * Provenance policy for sink findings (PLAN.md P5 item 2).
 *
 * `eslint-plugin-security` flags any non-literal argument to a sink. On this repository that
 * is 136 of 200 findings - 68% from one rule - and reading them shows `mkdirSync(dir)` from
 * config, `statSync(full)` inside a directory walk, temp paths in tests. None of it
 * attacker-controlled. The rule cannot tell, because it never asks where the value came from.
 *
 * **Sources are deliberately narrow, and `process.env` is deliberately absent.** Env vars are
 * operator configuration, not attacker input; treating them as a source would re-flag exactly
 * the config-driven paths this is meant to quieten, and the noise would return wearing a
 * taint-analysis badge. `process.argv` IS included: for a CLI it is user input.
 *
 * A function PARAMETER is not a source either. Every function taking an argument would light
 * up, and cross-function propagation is P5 item 4's job, bounded to depth 3.
 */
const TAINT_QUERY: TaintQuery = {
  sourceRoots: new Set(["req", "request", "ctx"]),
  sourceExpressions: [
    /^process\.argv\b/,
    /^(window\.)?location\.(search|hash|href)\b/,
    /^document\.cookie\b/,
  ],
  // `resolveSafe` is this repository's containment primitive (packages/fsx/src/workspace.ts).
  sanitizers: new Set(["resolveSafe", "escapeHtml", "sanitize", "encodeURIComponent"]),
};

const TS_FAMILY_EXT: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
};

/**
 * Taint modulates CONFIDENCE; it never deletes a finding.
 *
 * Deleting would convert an incomplete source list into silent false negatives - the failure
 * mode a security tool cannot afford, and one nobody would notice. Downgrading keeps the
 * finding visible and lets it weigh correctly, because `confidence` now multiplies into
 * `expectedHarm`: an untraced sink contributes about a third of what it used to, and a
 * genuinely tainted one outranks everything around it. The two changes compose by design.
 */
function adjustForTaint(base: number, verdict: TaintVerdict): number {
  switch (verdict) {
    // Reached a source with nothing cleaning it. This is the finding the rule was written for.
    case "tainted":
      return Math.min(0.95, base * 1.35);
    // A source, then a sanitizer. Reported, but it should sit near the bottom of the list.
    case "sanitized":
      return Math.max(0.05, base * 0.2);
    // No source found inside this function. Usually internal, sometimes a caller's argument
    // we cannot see yet - hence downgraded, not dropped.
    case "untraced":
      return Math.max(0.1, base * 0.35);
  }
}

/**
 * How far a `lexical`-tier finding's confidence is cut (HLD §8.3).
 *
 * A regex hit in a file nobody parsed might be in a comment, a string, or real code - the
 * distinction the context gate makes for TypeScript and cannot make for Python. Measured on
 * express and this repository, 35-64% of raw regex matches sit in a context where the rule
 * cannot hold, so a little over half is the honest discount for not knowing which.
 *
 * Not zero, and not a filter: the finding may well be real, and hiding it would trade visible
 * noise for silent blindness on every non-TypeScript file in the repository.
 */
const LEXICAL_CONFIDENCE_FACTOR = 0.45;

/** Absent confidence means "unqualified", so it stays unqualified rather than becoming 0. */
function scaleConfidence(base: number | undefined, factor: number): number | undefined {
  if (base === undefined) return undefined;
  return factor === 1 ? base : Math.max(0.05, Math.round(base * factor * 1000) / 1000);
}

let _issueSeq = 0;
function mkIssue(dim: Dimension, sev: number, title: string, file: string, line: number, br: number, conf?: number, churn?: number): Issue {
  return { id: `iss_${_issueSeq++}`, dimension: dim, severity: sev, confidence: conf, title, file, line, blastRadius: br, churn: churn ?? 1 };
}

async function analyzeFiles(files: ScannedFile[], fanIn: Map<string, number>, churnByFile: Map<string, number>, ctx?: PipelineContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) {
      await yieldToEventLoop();
      throwIfAborted(ctx);
    }
    const f = files[idx];
    if (!f.text) continue;
    const br = 1 + (fanIn.get(f.rel) || 0); // blast radius from graph fan-in
    const ch = churnByFile.get(f.rel) || 1;
    /**
     * HLD §8.3: a `lexical`-tier file was matched by regex alone - no parse, so no idea
     * whether a hit sits in a comment, a string, or running code. The design always said those
     * findings are "marked low-confidence"; nothing did it until now.
     *
     * This is the same boundary as `syntacticSpans`, and deliberately so: the files that get
     * no context gating are exactly the files whose findings cannot be trusted as far.
     */
    const tier = tierForExt(f.ext);
    const tierPenalty = tier === "lexical" ? LEXICAL_CONFIDENCE_FACTOR : 1;
    const lines = f.text.split("\n");
    /**
     * Comment/string ranges for this file, computed ONCE and shared by all 12 rules. Empty for
     * languages the TS scanner does not cover (Python), which makes every position `code` and
     * leaves those files scored exactly as before - see `syntacticSpans`.
     */
    const spans = syntacticSpans(f.text, f.ext);
    // Absolute offset of each line start, so a per-line regex index becomes a file offset.
    const lineStart: number[] = new Array(lines.length);
    for (let i = 0, at = 0; i < lines.length; i++) {
      lineStart[i] = at;
      at += lines[i].length + 1; // +1 for the "\n" removed by split
    }
    for (const rule of RULES) {
      if (rule.exts && !rule.exts[f.ext]) continue;
      const validContexts = rule.context ?? DEFAULT_CONTEXT;
      let emitted = 0;
      let occurrences = 0;
      let firstIssueIndex = -1;
      for (const [lineIndex, line] of lines.entries()) {
        const m = rule.re.exec(line);
        if (!m || (rule.validate && !rule.validate(line, m))) continue;
        // Structural gate. `spans` empty => "code" => unchanged behaviour.
        if (spans.length && !validContexts.includes(contextAt(spans, lineStart[lineIndex] + m.index)))
          continue;
        occurrences++;
        // Keep emitting only up to the cap: the issue list is rendered and
        // stored, so it stays bounded. Counting continues past it so the score
        // can tell 500 matches from 5 (review B3) — scanning the remaining lines
        // is the same regex pass either way, so this costs nothing extra.
        if (emitted < HITS_PER_RULE_PER_FILE) {
          if (firstIssueIndex === -1) firstIssueIndex = issues.length;
          issues.push(
            mkIssue(
              rule.dimension, rule.severity, rule.title, f.rel, lineIndex + 1, br,
              scaleConfidence(rule.confidence, tierPenalty), ch,
            ),
          );
          emitted++;
        }
      }
      // Volume is recorded once per (rule, file) group, on the first emitted
      // issue. Setting it on all of them would multiply the same excess by the
      // number of emitted markers.
      if (occurrences > HITS_PER_RULE_PER_FILE && firstIssueIndex >= 0) {
        const first = issues[firstIssueIndex];
        if (first) first.occurrences = occurrences;
      }
    }
    // AST-based security detector layer (eslint-plugin-security), catches
    // vulnerability classes the line-regex RULES above are structurally blind
    // to (ReDoS regex literals, dynamic fs/require paths, weak randomness, ...).
    const secFindings = lintForSecurity(f.text, f.ext);
    // Parse once, and only if a sink finding actually needs provenance checking.
    let taintSf: ts.SourceFile | null = null;
    for (const f2 of secFindings) {
      let confidence = f2.confidence;
      if (f2.taintable && TS_FAMILY_EXT[f.ext]) {
        taintSf ??= ts.createSourceFile(f.rel, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const call = callAt(taintSf, f2.line, f2.column);
        const arg = call?.arguments[0];
        if (arg) confidence = adjustForTaint(confidence, classifyTaint(arg, TAINT_QUERY));
      }
      issues.push(mkIssue("security", f2.severity, f2.title, f.rel, f2.line, br, scaleConfidence(confidence, tierPenalty), ch));
    }

    // God-file: very large source file → maintainability penalty scaled by fan-in.
    if (f.loc > 600) {
      issues.push(
        mkIssue("maintainability", f.loc > 1200 ? 4 : 2, `Large file (${f.loc} LOC)`, f.rel, 1, br, 0.9, ch)
      );
    }
  }
  return issues;
}

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

/** Test integrity: presence/ratio of test files. */
function analyzeTests(files: ScannedFile[]): Issue[] {
  const code = files.filter((f) => CODE_EXTS[f.ext]);
  if (code.length === 0) return [];
  const tests = code.filter((f) => /(\.|_|\/)(test|spec)/i.test(f.rel) || /(^|\/)tests?\//i.test(f.rel));
  const ratio = tests.length / code.length;
  const issues: Issue[] = [];
  if (tests.length === 0) {
    issues.push(mkIssue("test_integrity", 4, "No test files detected", ".", 1, 3, 0.6));
  } else if (ratio < 0.1) {
    issues.push(mkIssue("test_integrity", 2, `Low test coverage ratio (${(ratio * 100).toFixed(0)}% of code files)`, ".", 1, 2, 0.75));
  }
  return issues;
}

/**
 * Damped blast-radius multiplier.
 *
 * Fixes review item B2. The raw model was `penalty = severity × blastRadius`
 * with `blastRadius = 1 + fanIn`, which inverted the ranking it was selling: a
 * `TODO` (severity 1) in a file imported 60× scored 61, while an `eval()`
 * (severity 5) in a leaf file scored 5 — the TODO outranking the eval 12:1. The
 * README calls the score "blast-radius-weighted, explainable"; it was weighted
 * in a way that systematically buried the findings that matter.
 *
 * Log damping is what `judgeScore` in agents/orchestrator.ts already did
 * (`1 + log2(1 + blastRadius)`), so this also makes the two scorers agree
 * instead of ranking the same finding differently.
 *
 * The cap is the load-bearing part. Without it, damping alone still lets a
 * severity-1 finding in a sufficiently-imported file outrank a severity-5 one
 * (at fanIn ≈ 1000 the multiplier reaches ~11). At 8 — which log2 reaches around
 * fanIn 127 — the worst a severity-1 finding can contribute is 8, while the
 * least a severity-5 finding can contribute is 5 × 2 = 10. So severity 5 always
 * outranks severity 1, whatever the graph looks like, and that invariant is
 * asserted in the tests.
 *
 * Blast radius stays deliberately file-level here. Symbol-level reachability
 * (`QueryEngine.reachableCallers`) is the real answer and is P3 work — it needs
 * findings to carry a symbol, which the regex rules cannot supply.
 */
const MAX_BLAST_MULTIPLIER = 8;

function blastMultiplier(blastRadius: number): number {
  return Math.min(MAX_BLAST_MULTIPLIER, 1 + Math.log2(1 + Math.max(0, blastRadius)));
}

/**
 * Volume multiplier for a rule that matched many times in one file.
 *
 * Fixes review item B3. `analyzeFiles` stops emitting after
 * `HITS_PER_RULE_PER_FILE` matches, which is a sensible bound on the issue list
 * and on memory — but it was also doing metric duty, so a file with 500
 * `console.log`s and a file with 5 scored identically, and deleting 400 of them
 * moved the score by zero.
 *
 * Returns exactly 1 at or below the cap, so every repository whose files are
 * under it scores precisely as it did before — the common case is unchanged.
 * Past the cap, volume registers logarithmically: 10× the cap roughly triples
 * the contribution rather than multiplying it by ten.
 */
function volumeMultiplier(occurrences: number | undefined): number {
  if (occurrences === undefined || occurrences <= HITS_PER_RULE_PER_FILE) return 1;
  return 1 + Math.log2(occurrences / HITS_PER_RULE_PER_FILE);
}

/**
 * Expected harm from one finding — the single weighting both the score and the displayed
 * order use.
 *
 *   severity × blastMultiplier × volumeMultiplier × confidence
 *
 * **Why confidence belongs here (PLAN.md §5.2).** The scorer stored `confidence` on every
 * finding and then ignored it, so a 0.7 "Possible SQL string concatenation" weighed exactly as
 * much as a 0.95 `eval()`. `severity` and `confidence` are orthogonal axes, and the rule table
 * proves it rather than merely asserting it: `Use of eval()` and `Possible hardcoded secret`
 * are BOTH severity 5. The uncertain one is not severity-discounted, because severity means
 * *impact if real*. Multiplying by P(real) is therefore an expectation, not a double-count.
 *
 * **This raises scores, and that is the correction, not generosity.** The old model charged
 * every guess at full price. `k = 0.06` is deliberately NOT rescaled to hold the old headline:
 * re-tuning a hand-picked constant to conceal a deliberate change is how a number stops
 * meaning anything. The pillar split above moved the headline for the same kind of reason.
 *
 * `?? 1` — absent means *unqualified*, so no discount. Defaulting to 0 would silently delete
 * every finding from a producer that does not set the field.
 *
 * One function, not two expressions kept in step by a comment: `scoreIssues` and the issue
 * ordering in `indexRepo` MUST apply identical weights, or the list disagrees with the number
 * it explains (review item B2, which surfaced twice).
 */
function expectedHarm(i: Issue): number {
  return (
    i.severity *
    blastMultiplier(i.blastRadius) *
    volumeMultiplier(i.occurrences) *
    (i.confidence ?? 1)
  );
}

/**
 * The Health Score model.
 *
 *   penalty  = Σ severity × blastMultiplier × volumeMultiplier × confidence
 *   subScore = 100 × exp(-k · penalty / sizeFactor)
 *
 * Larger codebases tolerate more raw penalty (normalised by LOC).
 *
 * ONE KERNEL, THREE PILLARS (PLAN.md §5.1). The formula above runs per dimension exactly as
 * it always did; what changed is the aggregation above it. `overall` used to blend all five
 * dimensions, which meant the headline mixed "how likely is this to break" with "how hard is
 * this to work in" — maintainability alone was 0.22 of a number presented as risk.
 *
 * `overall` is now the DEFECT RISK pillar alone. The other pillars are returned beside it and
 * are never averaged in. This moves every repository's headline number, deliberately: the old
 * one answered a question nobody asked.
 *
 * Exported so the swarm's projected score is a real simulation through this exact function
 * rather than a parallel guess at it (review item C5).
 *
 * `depCount` used to be a third parameter and was never read in the body — the dependency
 * count reaches the score only through the findings it produces. Removed rather than left
 * standing as a claim about what the model weighs.
 */
export function scoreIssues(
  issues: Issue[],
  loc: number,
): { dimensions: DimensionScore[]; overall: number; pillars: PillarScore[] } {
  const sizeFactor = Math.max(1, Math.log10(Math.max(loc, 10)) ** 2); // ~1 small → ~10 huge
  const k = 0.06;

  const dims: DimensionScore[] = (Object.keys(DIMENSION_META) as Dimension[]).map((dim) => {
    const di = issues.filter((i) => i.dimension === dim);
    const penalty = di.reduce((s, i) => s + expectedHarm(i), 0);
    const norm = penalty / sizeFactor;
    const sub = 100 * Math.exp(-k * norm);
    return {
      dimension: dim,
      score: Math.round(Math.max(0, Math.min(100, sub))),
      penalty: Math.round(penalty * 10) / 10,
      issueCount: di.length,
    };
  });

  const pillars = pillarsFrom(dims);

  // The surfaced number is the defect-risk pillar, and only it.
  const surfaced = pillars.find((p) => PILLAR_META[p.pillar].surfaced);
  return { dimensions: dims, overall: surfaced?.score ?? 0, pillars };
}

const VIZ_NODE_CAP = 350;

/** Build the renderable node/edge graph (files + dirs + import/containment edges). */
function buildVizGraph(
  files: ScannedFile[],
  importEdges: Array<{ from: string; to: string }>,
  fanIn: Map<string, number>,
  issues: Issue[]
): VizGraph {
  // Per-file issue aggregation.
  const issueCount = new Map<string, number>();
  const worstSev = new Map<string, number>();
  for (const i of issues) {
    issueCount.set(i.file, (issueCount.get(i.file) || 0) + 1);
    worstSev.set(i.file, Math.max(worstSev.get(i.file) || 0, i.severity));
  }

  // Choose which files to render; keep highest-impact when over the cap.
  let chosen = files;
  let truncated = false;
  if (files.length > VIZ_NODE_CAP) {
    chosen = [...files]
      .sort(
        (a, b) =>
          (fanIn.get(b.rel) || 0) * 3 + b.loc / 100 - ((fanIn.get(a.rel) || 0) * 3 + a.loc / 100)
      )
      .slice(0, VIZ_NODE_CAP);
    truncated = true;
  }
  const included = new Set(chosen.map((f) => f.rel));

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const toPosix = (p: string) => p.split(path.sep).join("/");
  function ensureDir(dir: string): string {
    const id = dir === "" || dir === "." ? "." : dir;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: id === "." ? "/" : path.posix.basename(id),
        kind: "dir",
        language: null,
        loc: 0,
        fanIn: 0,
        issues: 0,
        worstSeverity: 0,
      });
    }
    return id;
  }
  // Build the directory chain and containment edges up to root.
  function linkChain(relFile: string) {
    const posix = toPosix(relFile);
    let dir = path.posix.dirname(posix);
    let child = posix;
    // file's immediate dir -> ... -> root
    while (true) {
      const dirId = ensureDir(dir);
      edges.push({ source: dirId, target: child, kind: "contains" });
      if (dir === "." || dir === "") break;
      child = dirId;
      dir = path.posix.dirname(dir);
    }
  }

  for (const f of chosen) {
    const posix = toPosix(f.rel);
    nodes.set(posix, {
      id: posix,
      label: path.posix.basename(posix),
      kind: "file",
      language: LANG_BY_EXT[f.ext] || null,
      loc: f.loc,
      fanIn: fanIn.get(f.rel) || 0,
      issues: issueCount.get(f.rel) || 0,
      worstSeverity: worstSev.get(f.rel) || 0,
    });
    linkChain(f.rel);
  }

  for (const e of importEdges) {
    if (included.has(e.from) && included.has(e.to)) {
      edges.push({ source: toPosix(e.from), target: toPosix(e.to), kind: "imports" });
    }
  }

  return { nodes: [...nodes.values()], edges, truncated };
}

/** Build the nested file tree for circle-packing (all files, not capped). */
function buildTree(files: ScannedFile[], issuesByFile: Map<string, number>): TreeNode {
  const root: TreeNode = { name: "/", path: ".", children: [] };
  const dirCache = new Map<string, TreeNode>([[".", root]]);

  function ensureDir(dirPosix: string): TreeNode {
    if (dirCache.has(dirPosix)) return dirCache.get(dirPosix)!;
    const parentPath = path.posix.dirname(dirPosix);
    const parent = parentPath === dirPosix ? root : ensureDir(parentPath === "" ? "." : parentPath);
    const node: TreeNode = { name: path.posix.basename(dirPosix), path: dirPosix, children: [] };
    parent.children!.push(node);
    dirCache.set(dirPosix, node);
    return node;
  }

  for (const f of files) {
    const posix = f.rel.split(path.sep).join("/");
    const dirPosix = path.posix.dirname(posix);
    const parent = dirPosix === "." || dirPosix === "" ? root : ensureDir(dirPosix);
    parent.children!.push({
      name: path.posix.basename(posix),
      path: posix,
      ext: f.ext,
      loc: Math.max(1, f.loc),
      issues: issuesByFile.get(f.rel) || 0,
    });
  }
  return root;
}

/** Aggregate files into top-level modules + inter-module import edges (flowchart). */
function buildModuleGraph(
  files: ScannedFile[],
  importEdges: Array<{ from: string; to: string }>,
  issuesByFile: Map<string, number>
): ModuleGraph {
  // Count files per top-level dir; big top dirs get expanded to 2 levels so the
  // architecture graph stays meaningful instead of a few giant blobs.
  const topCount = new Map<string, number>();
  for (const f of files) {
    const seg = f.rel.split(path.sep).join("/").split("/");
    const top = seg.length > 1 ? seg[0] : "(root)";
    topCount.set(top, (topCount.get(top) || 0) + 1);
  }
  const EXPAND_THRESHOLD = 12;
  const moduleOf = (rel: string): string => {
    const seg = rel.split(path.sep).join("/").split("/");
    if (seg.length <= 1) return "(root)";
    const top = seg[0];
    if (seg.length >= 3 && (topCount.get(top) || 0) > EXPAND_THRESHOLD) {
      return top + "/" + seg[1];
    }
    return top;
  };

  const mods = new Map<string, ModuleNode>();
  const langCount = new Map<string, Map<string, number>>();
  for (const f of files) {
    const id = moduleOf(f.rel);
    let m = mods.get(id);
    if (!m) {
      m = { id, label: id, files: 0, loc: 0, issues: 0, language: null, tier: 0 };
      mods.set(id, m);
      langCount.set(id, new Map());
    }
    m.files += 1;
    m.loc += f.loc;
    m.issues += issuesByFile.get(f.rel) || 0;
    const lang = LANG_BY_EXT[f.ext];
    if (lang) {
      const lc = langCount.get(id)!;
      lc.set(lang, (lc.get(lang) || 0) + 1);
    }
  }
  for (const [id, m] of mods) {
    const lc = langCount.get(id)!;
    let best: string | null = null;
    let bestN = 0;
    for (const [lang, n] of lc) if (n > bestN) { bestN = n; best = lang; }
    m.language = best;
  }

  const edgeW = new Map<string, ModuleEdge>();
  for (const e of importEdges) {
    const s = moduleOf(e.from);
    const t = moduleOf(e.to);
    if (s === t) continue;
    const key = s + "→" + t;
    const ex = edgeW.get(key);
    if (ex) ex.weight += 1;
    else edgeW.set(key, { source: s, target: t, weight: 1 });
  }
  const edges = [...edgeW.values()];

  // Assign tiers by longest-path depth (cycles broken by visited guard).
  const adj = new Map<string, string[]>();
  for (const m of mods.keys()) adj.set(m, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const tierOf = new Map<string, number>();
  function depth(node: string, seen: Set<string>): number {
    if (tierOf.has(node)) return tierOf.get(node)!;
    if (seen.has(node)) return 0;
    seen.add(node);
    let d = 0;
    for (const next of adj.get(node) || []) d = Math.max(d, 1 + depth(next, seen));
    seen.delete(node);
    tierOf.set(node, d);
    return d;
  }
  for (const m of mods.keys()) m && (mods.get(m)!.tier = depth(m, new Set()));

  return { nodes: [...mods.values()].sort((a, b) => a.tier - b.tier || b.loc - a.loc), edges };
}

/** Full pipeline: scan a repo/folder dir → result (graph + score + viz). */
export async function indexRepo(root: string, ctx?: PipelineContext): Promise<IndexResult> {
  _issueSeq = 0;
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
  const { files, languages, loc, coverage } = await scan(root, ctx);
  const { fanIn, importEdges } = await computeImportGraph(files, ctx);
  
  const dep = analyzeDependencies(root, files);
  const codeIssues = await analyzeFiles(files, fanIn, churnMap, ctx);
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

  const { dimensions, overall } = scoreIssues(issues, loc);
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

  // Symbol-level knowledge graph (code intelligence layer).
  const symbolGraph = await buildSymbolGraph(
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
  );

  return {
    loc,
    languages,
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
