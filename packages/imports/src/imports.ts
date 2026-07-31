import path from "node:path";
import {
  YIELD_EVERY,
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

/** Resolve import edges between scanned files + fan-in centrality. */
export interface ImportGraph {
  fanIn: Map<string, number>;
  importEdges: Array<{ from: string; to: string }>;
}
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


// Detection moved to `@codegraph/detect-engine` (LLD §13).
