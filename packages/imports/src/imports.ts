import path from "node:path";
import {
  YIELD_EVERY,
  emitPhase,
  throwIfAborted,
  yieldToEventLoop,
  type PipelineContext,
  type ScannedFile,
} from "@codegraph/analysis-model";
import { CODE_EXTS } from "@codegraph/analysis-model";

/**
 * File-level import edges.
 *
 * NOT a `lang-*` package, though it was created as one. `lang-packages-are-leaves` in
 * `.dependency-cruiser.cjs` rejected the name immediately: a `lang-*` package "knows its own
 * syntax and nothing about detection, scoring, or storage", which is what makes adding a
 * language an additive change. This stage needs `ScannedFile` and `PipelineContext`, so it is a
 * pipeline stage that happens to contain per-language syntax - not a language plugin. The gate
 * was right about the name, and the name was the thing that was wrong.
 *
 * The language-specific half of the pipeline: which syntax declares a dependency, and how a
 * written specifier maps onto a file on disk. Separated so adding a language is a change here
 * rather than a change to the walker, the scanner and the orchestrator.
 *
 * Distinct from `core-graph`'s extractors, which resolve SYMBOLS. This resolves FILES, it runs
 * before any parse, and its output is what feeds fan-in - the blast radius the score weights by.
 *
 * Pure: text and scanned files in, edges out. No filesystem access, which is why it can live
 * outside the I/O packages.
 */

export function extractImports(text: string, ext: string): string[] {
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

  /*
   * JS/TS (and other C-family): EVERY specifier, relative or not.
   *
   * This used to keep only the ones starting with `.`, because the single consumer resolved
   * file-to-file edges and a bare specifier can never name a file in the tree. The cost was
   * invisible until something else wanted them: third-party imports were discarded here, three
   * layers before anything could have recorded them, so a TypeScript repository reported zero
   * external dependencies while its manifest declared twenty-six. Deciding what a specifier
   * names is the resolver's job; this function's job is to find them all.
   */
  if (CODE_EXTS[ext]) {
    const re = /(?:import\s+[^'"]*from\s+|require\(\s*|import\s*\(\s*|from\s+)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) imports.push(m[1]!);
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

/** Resolve import edges between scanned files + fan-in centrality. */
export interface ImportGraph {
  fanIn: Map<string, number>;
  importEdges: Array<{ from: string; to: string }>;
  /**
   * File -> external package it imports, one entry per distinct pair.
   *
   * The resolution loop below already decides, for every specifier, whether it names a file in
   * this repository. The ones that do not are exactly the third-party dependencies, and until
   * now they were dropped on the floor: `GraphNodeKind` has declared a `"dependency"` node and
   * `GraphEdge.kind` a `"depends"` edge since the model was written, and nothing ever produced
   * either. "What depends on <package>" could therefore only ever answer "nothing", which is
   * not an absence of dependencies but an absence of the analysis.
   */
  externalEdges: Array<{ from: string; pkg: string }>;
}

/**
 * The installable name a specifier belongs to.
 *
 * `@scope/pkg/deep/path` -> `@scope/pkg`, `pkg/sub` -> `pkg`. Deep imports are extremely
 * common (`lucide-react/icons/x`, `date-fns/format`) and counting them as separate packages
 * would fragment the very grouping this exists to produce.
 *
 * Returns null for everything that is not an installable dependency:
 *
 * - Relative and absolute paths, URLs, and `#private` subpath imports.
 * - Build-tool path ALIASES. `@/lib/store` is this repository's own source behind a tsconfig
 *   path mapping, and a naive scope split turns it into a package called `@/lib`. A scope has
 *   a name; `@` alone does not. `~/…` is the same idea in another tool.
 * - The standard libraries. A builtin is not a dependency, it is the platform, and listing one
 *   would put `path` at the top of every JavaScript repository's chart and `typing` at the top
 *   of every Python one - which is exactly what the first run of this analysis produced.
 */
export function packageOf(specifier: string): string | null {
  const s = specifier.trim();
  if (!s || s.startsWith(".") || s.startsWith("/") || s.startsWith("#") || s.startsWith("~")) return null;
  /*
   * A module specifier is one word. The extraction regex has a `from\s+['"]...['"]` branch that
   * cannot tell a real import from the same shape occurring inside a template literal or a
   * comment, and while only relative specifiers were kept the junk filtered itself out. Once
   * every specifier was kept, a fragment of source code - `")) {\n        cur.status ="` -
   * became a "dependency" on the graph. Anything containing whitespace, quotes or brackets is
   * not a package name, whatever the regex thought it found.
   */
  if (/[\s"'`(){}[\]<>;=]/.test(s)) return null;
  if (s.startsWith("@/")) return null; // path alias, not a scope
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("node:")) return null; // http:, data:, file:
  if (s.startsWith("node:")) return null;
  if (NODE_BUILTINS.has(s) || PYTHON_STDLIB.has(s)) return null;
  const parts = s.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (s.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0]!;
}

/** Bare builtin specifiers. `node:`-prefixed ones are handled by the prefix test above. */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * Python's standard library, top-level module names only.
 *
 * Measured on this repository before this set existed: the five most-depended-upon
 * "dependencies" were `__future__`, `time`, `dataclasses`, `typing` and `collections`, and the
 * only genuine third-party name in the list was `pytest`.
 */
const PYTHON_STDLIB = new Set([
  "__future__", "abc", "argparse", "ast", "asyncio", "base64", "binascii", "bisect", "builtins",
  "bz2", "calendar", "cmath", "collections", "concurrent", "configparser", "contextlib", "copy",
  "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis", "email", "enum",
  "errno", "faulthandler", "filecmp", "fileinput", "fnmatch", "fractions", "functools", "gc",
  "getpass", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http", "importlib", "inspect",
  "io", "ipaddress", "itertools", "json", "keyword", "linecache", "locale", "logging", "lzma",
  "math", "mimetypes", "multiprocessing", "operator", "os", "pathlib", "pickle", "platform",
  "pprint", "queue", "random", "re", "secrets", "select", "shlex", "shutil", "signal", "site",
  "socket", "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess", "sys",
  "tarfile", "tempfile", "textwrap", "threading", "time", "timeit", "tkinter", "token",
  "tokenize", "traceback", "types", "typing", "unicodedata", "unittest", "urllib", "uuid",
  "warnings", "weakref", "webbrowser", "xml", "zipfile", "zlib", "zoneinfo",
]);
export async function computeImportGraph(files: ScannedFile[], ctx?: PipelineContext): Promise<ImportGraph> {
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

  /* Deduplicated: a file importing four symbols from one package in four statements depends on
     it once. Without this the node's weight would measure statement style, not coupling. */
  const externalSeen = new Set<string>();
  const externalEdges: Array<{ from: string; pkg: string }> = [];
  const linkExternal = (from: string, specifier: string) => {
    const pkg = packageOf(specifier);
    if (!pkg) return;
    const key = `${from}\u0000${pkg}`;
    if (externalSeen.has(key)) return;
    externalSeen.add(key);
    externalEdges.push({ from, pkg });
  };

  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) {
      await yieldToEventLoop();
      throwIfAborted(ctx);
      emitPhase(ctx, "imports", idx, files.length);
    }
    const f = files[idx];
    const rel = toPosix(f.rel);
    const dir = path.posix.dirname(rel);

    for (const imp of f.imports) {
      if (f.ext === ".go") {
        // Local Go imports share the repo's module prefix; match the longest
        // trailing path segment run against an actual repo directory.
        const segs = imp.split("/").filter(Boolean);
        let matched = false;
        for (let k = Math.min(segs.length, 8); k >= 1; k--) {
          const suffix = segs.slice(segs.length - k).join("/");
          const pkgFiles = goDirs.get(suffix);
          if (pkgFiles && suffix !== dir) {
            for (const target of pkgFiles) link(f.rel, target);
            matched = true;
            break;
          }
        }
        // A Go import path is a domain-qualified module (`github.com/gorilla/mux`), so the
        // JS package rules do not apply: take the first three segments, which is the
        // host/owner/repo that `go.mod` requires, and skip the standard library, which has
        // no dot in its first segment (`fmt`, `net/http`).
        if (!matched && segs.length >= 3 && segs[0]!.includes(".")) {
          const key = `${f.rel}\u0000${segs.slice(0, 3).join("/")}`;
          if (!externalSeen.has(key)) {
            externalSeen.add(key);
            externalEdges.push({ from: f.rel, pkg: segs.slice(0, 3).join("/") });
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
        // The top-level module is the distribution name often enough to be useful, and a
        // relative import is never external.
        else if (!imp.startsWith(".")) linkExternal(f.rel, imp.split(".")[0]!);
      } else {
        // JS/TS relative import.
        const t = path.posix.normalize(path.posix.join(dir, imp)).replace(/^\.\//, "");
        const cand = byNoExt.get(t) || byNoExt.get(t + "/index") || byNoExt.get(t.replace(/\/$/, ""));
        if (cand) link(f.rel, cand);
        // Unresolved AND not relative: the specifier names something outside this tree.
        // A relative path that resolved to nothing is a broken import, not a dependency.
        else linkExternal(f.rel, imp);
      }
    }
  }
  return { fanIn, importEdges, externalEdges };
}


// Detection moved to `@codegraph/detect-engine` (LLD §13).
