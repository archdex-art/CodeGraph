import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import type {
  Dimension,
  DimensionScore,
  GraphStats,
  GraphNode,
  GraphEdge,
  Issue,
  LanguageStat,
  VizGraph,
  TreeNode,
  ModuleGraph,
  ModuleNode,
  ModuleEdge,
  SymbolGraph,
} from "./types";
import { DIMENSION_META } from "./types";
import { buildSymbolGraph } from "./codeintel/graph";
import { extractorFor } from "./codeintel/extractors";

const exec = promisify(execFile);

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

const MAX_FILES = Number(process.env.CG_MAX_FILES) || 4000;
const MAX_FILE_BYTES = 400_000;

export interface IndexResult {
  loc: number;
  languages: LanguageStat[];
  graph: GraphStats;
  dimensions: DimensionScore[];
  issues: Issue[];
  dependencies: string[];
  score: number;
  viz: VizGraph;
  tree: TreeNode;
  modules: ModuleGraph;
  symbolGraph: SymbolGraph;
}

interface ScannedFile {
  rel: string;
  ext: string;
  loc: number;
  text: string;
  imports: string[]; // resolved-ish relative targets
}

/**
 * Clone a public git repo. With no `destDir`, clones into a disposable temp
 * dir (single-branch, depth 1 — fastest path for one-shot indexing/fix
 * sandboxes; caller must rm it). With `destDir`, clones into that exact path
 * — used for the editor's persistent workspace, so it fetches all branches
 * (bounded depth) to support real branch switching + history.
 */
export async function cloneRepo(url: string, destDir?: string): Promise<string> {
  // Allows an optional `user:token@` userinfo component — used for
  // authenticated clones (see gitops.withToken); the token itself is never
  // logged or persisted by this function, only passed through to `git clone`'s argv.
  if (!/^https?:\/\/(?:[^@/]+@)?[\w.-]+\/[\w./~-]+/.test(url)) {
    throw new Error("Invalid repository URL. Use a public https git URL.");
  }
  const dir = destDir ?? mkdtempSync(path.join(tmpdir(), "cg-"));
  if (destDir) mkdirSync(path.dirname(destDir), { recursive: true });
  const args = destDir
    ? ["clone", "--depth", "50", url, dir]
    : ["clone", "--depth", "1", "--single-branch", url, dir];
  await exec("git", args, {
    timeout: Number(process.env.CG_CLONE_TIMEOUT_MS) || 90_000,
    maxBuffer: 1024 * 1024 * 16,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return dir;
}

/** Validate and resolve a local folder path for indexing (no clone). */
export function resolveLocalDir(inputPath: string): string {
  const resolved = path.resolve(inputPath.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS[name] && !name.startsWith(".")) stack.push(full);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        out.push(full);
      }
    }
  }
  return out;
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

/** Walk the repo, build per-file records + language stats. */
function scan(root: string): { files: ScannedFile[]; languages: LanguageStat[]; loc: number } {
  const paths = walk(root);
  const files: ScannedFile[] = [];
  const langMap = new Map<string, { files: number; loc: number }>();
  let totalLoc = 0;

  for (const full of paths) {
    const ext = path.extname(full).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
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

  return { files, languages, loc: totalLoc };
}

/** Resolve import edges between scanned files + fan-in centrality. */
interface ImportGraph {
  fanIn: Map<string, number>;
  importEdges: Array<{ from: string; to: string }>;
}
function computeImportGraph(files: ScannedFile[]): ImportGraph {
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

  for (const f of files) {
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

let issueSeq = 0;
function mkIssue(
  dimension: Dimension,
  severity: number,
  title: string,
  file: string,
  line: number,
  blastRadius: number
): Issue {
  return { id: `i${issueSeq++}`, dimension, severity, title, file, line, blastRadius };
}

interface Rule {
  re: RegExp;
  dimension: Dimension;
  severity: number;
  title: string;
  exts?: Record<string, true>;
  /** Optional second-pass filter over the regex match to cut heuristic false
   *  positives — e.g. the secret rule uses this to reject placeholder/example
   *  values (`api_key="am_live_..."` in docs/marketing copy is not a live secret). */
  validate?: (line: string, match: RegExpExecArray) => boolean;
}

// A real secret never contains a literal "..." ellipsis or matches a common
// placeholder word — those are documentation/example conventions.
const PLACEHOLDER_SECRET_RE = /^(\.{3,}|x{4,}|\*{4,}|your[-_ ]?\w*|example\w*|placeholder\w*|changeme|insert[-_ ]?\w*|redacted|dummy|fake|sample|todo|<.*>|\{\{.*\}\})$/i;
function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRET_RE.test(value) || value.includes("...");
}

// Heuristic, language-agnostic-ish defect/risk rules.
const RULES: Rule[] = [
  { re: /\beval\s*\(/, dimension: "security", severity: 5, title: "Use of eval()" },
  { re: /child_process|os\.system\(|subprocess\.(call|run|Popen)\(/, dimension: "security", severity: 3, title: "Shell/process execution" },
  {
    re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"]([^'"]{6,})['"]/i,
    dimension: "security", severity: 5, title: "Possible hardcoded secret",
    validate: (_line, m) => !isPlaceholderSecret(m[2]),
  },
  { re: /https?:\/\/[^"'\s]*(?<![\w.])(localhost|127\.0\.0\.1)/, dimension: "security", severity: 2, title: "Hardcoded local URL" },
  { re: /\bdangerouslySetInnerHTML\b|innerHTML\s*=/, dimension: "security", severity: 3, title: "Raw HTML injection sink" },
  { re: /SELECT\s+.+\+|query\(\s*['"`].*\$\{/i, dimension: "security", severity: 4, title: "Possible SQL string concatenation" },

  { re: /\bconsole\.(log|debug)\b|^\s*print\(/m, dimension: "correctness", severity: 1, title: "Leftover debug output" },
  { re: /\bdebugger\b/, dimension: "correctness", severity: 2, title: "debugger statement" },
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/, dimension: "correctness", severity: 3, title: "Empty catch block" },
  { re: /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/, dimension: "maintainability", severity: 1, title: "TODO/FIXME marker" },
  { re: /@ts-(ignore|nocheck)|# type: ignore|eslint-disable/, dimension: "maintainability", severity: 2, title: "Suppressed checker" },
  { re: /:\s*any\b|\bas\s+any\b/, dimension: "correctness", severity: 1, title: "Untyped `any`", exts: { ".ts": true, ".tsx": true } },
];

function analyzeFiles(files: ScannedFile[], fanIn: Map<string, number>): Issue[] {
  const issues: Issue[] = [];
  for (const f of files) {
    if (!f.text) continue;
    const br = 1 + (fanIn.get(f.rel) || 0); // blast radius from graph fan-in
    const lines = f.text.split("\n");

    for (const rule of RULES) {
      if (rule.exts && !rule.exts[f.ext]) continue;
      for (let i = 0; i < lines.length; i++) {
        const m = rule.re.exec(lines[i]);
        if (m && (!rule.validate || rule.validate(lines[i], m))) {
          issues.push(mkIssue(rule.dimension, rule.severity, rule.title, f.rel, i + 1, br));
          break; // one hit per rule per file keeps signal clean
        }
      }
    }

    // God-file: very large source file → maintainability penalty scaled by fan-in.
    if (f.loc > 600) {
      issues.push(
        mkIssue("maintainability", f.loc > 1200 ? 4 : 2, `Large file (${f.loc} LOC)`, f.rel, 1, br)
      );
    }
  }
  return issues;
}

/** Dependency hygiene from manifests actually present in the repo. */
function analyzeDependencies(root: string): { issues: Issue[]; count: number; depsList: string[] } {
  const depsList: string[] = [];
  const issues: Issue[] = [];
  let count = 0;

  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      count = Object.keys(deps).length;
      depsList.push(...Object.keys(deps));
      for (const [name, range] of Object.entries(deps)) {
        const v = String(range);
        if (v === "*" || v === "latest" || v.startsWith("http") || v.startsWith("git")) {
          issues.push(mkIssue("dependency_hygiene", 3, `Unpinned dependency: ${name} (${v})`, "package.json", 1, 2));
        } else if (/^[~^]?0\./.test(v)) {
          issues.push(mkIssue("dependency_hygiene", 1, `Pre-1.0 dependency: ${name} (${v})`, "package.json", 1, 1));
        }
      }
      if (!existsSync(path.join(root, "package-lock.json")) &&
          !existsSync(path.join(root, "pnpm-lock.yaml")) &&
          !existsSync(path.join(root, "yarn.lock"))) {
        issues.push(mkIssue("dependency_hygiene", 2, "No lockfile committed", "package.json", 1, 2));
      }
    } catch {
      /* ignore malformed */
    }
  }

  const reqPath = path.join(root, "requirements.txt");
  if (existsSync(reqPath)) {
    try {
      const lines = readFileSync(reqPath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      count += lines.length;
      for (const l of lines) {
        const m = l.match(/^([A-Za-z0-9_-]+)/);
        if (m) depsList.push(m[1]);
        if (!/[=<>~]/.test(l)) {
          issues.push(mkIssue("dependency_hygiene", 2, `Unpinned dependency: ${l.trim()}`, "requirements.txt", 1, 1));
        }
      }
    } catch {
      /* ignore */
    }
  }

  return { issues, count, depsList };
}

/** Test integrity: presence/ratio of test files. */
function analyzeTests(files: ScannedFile[]): Issue[] {
  const code = files.filter((f) => CODE_EXTS[f.ext]);
  if (code.length === 0) return [];
  const tests = code.filter((f) => /(\.|_|\/)(test|spec)/i.test(f.rel) || /(^|\/)tests?\//i.test(f.rel));
  const ratio = tests.length / code.length;
  const issues: Issue[] = [];
  if (tests.length === 0) {
    issues.push(mkIssue("test_integrity", 4, "No test files detected", ".", 1, 3));
  } else if (ratio < 0.1) {
    issues.push(mkIssue("test_integrity", 2, `Low test coverage ratio (${(ratio * 100).toFixed(0)}% of code files)`, ".", 1, 2));
  }
  return issues;
}

/**
 * Score model (per design doc 07):
 *   penalty = Σ severity × blastRadius   (recency/confidence = 1 here)
 *   sub_score = 100 × exp(-k · penalty / sizeFactor)
 * Larger codebases tolerate more raw penalty (normalized by LOC).
 */
function score(issues: Issue[], loc: number, depCount: number): { dimensions: DimensionScore[]; overall: number } {
  const sizeFactor = Math.max(1, Math.log10(Math.max(loc, 10)) ** 2); // ~1 small → ~10 huge
  const k = 0.06;

  const dims: DimensionScore[] = (Object.keys(DIMENSION_META) as Dimension[]).map((dim) => {
    const di = issues.filter((i) => i.dimension === dim);
    const penalty = di.reduce((s, i) => s + i.severity * i.blastRadius, 0);
    const norm = penalty / sizeFactor;
    const sub = 100 * Math.exp(-k * norm);
    return {
      dimension: dim,
      score: Math.round(Math.max(0, Math.min(100, sub))),
      penalty: Math.round(penalty * 10) / 10,
      issueCount: di.length,
    };
  });

  const overall = dims.reduce((s, d) => s + d.score * DIMENSION_META[d.dimension].weight, 0);
  return { dimensions: dims, overall: Math.round(overall) };
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
export function indexRepo(root: string): IndexResult {
  issueSeq = 0;
  const { files, languages, loc } = scan(root);
  const { fanIn, importEdges } = computeImportGraph(files);

  const codeIssues = analyzeFiles(files, fanIn);
  const dep = analyzeDependencies(root);
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

  const { dimensions, overall } = score(issues, loc, dep.count);
  issues.sort((a, b) => b.severity * b.blastRadius - a.severity * a.blastRadius);

  // Per-file issue counts (shared by viz, tree, modules).
  const issuesByFile = new Map<string, number>();
  for (const i of issues) issuesByFile.set(i.file, (issuesByFile.get(i.file) || 0) + 1);

  const viz = buildVizGraph(files, importEdges, fanIn, issues);
  const tree = buildTree(files, issuesByFile);
  const modules = buildModuleGraph(files, importEdges, issuesByFile);

  // Symbol-level knowledge graph (code intelligence layer).
  const symbolGraph = buildSymbolGraph(
    files
      .filter((f) => f.text && extractorFor(f.ext))
      .map((f) => ({
        rel: f.rel.split(path.sep).join("/"),
        ext: f.ext,
        text: f.text,
        language: LANG_BY_EXT[f.ext] || "unknown",
      })),
    issuesByFile
  );

  return {
    loc,
    languages,
    graph: graphStats,
    dimensions,
    issues: issues.slice(0, 200),
    dependencies: dep.depsList,
    score: overall,
    viz,
    tree,
    modules,
    symbolGraph,
  };
}

export function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
