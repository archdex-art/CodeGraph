import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { LanguageStat } from "../types";
import { CODE_EXTS, LANG_BY_EXT, MAX_FILES, MAX_FILE_BYTES, SKIP_DIRS } from "./constants";
import { YIELD_EVERY, yieldToEventLoop } from "./util";

export interface ScannedFile {
  rel: string;
  ext: string;
  loc: number;
  text: string;
  imports: string[]; // resolved-ish relative targets
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
export async function scan(root: string): Promise<{ files: ScannedFile[]; languages: LanguageStat[]; loc: number }> {
  const paths = walk(root);
  const files: ScannedFile[] = [];
  const langMap = new Map<string, { files: number; loc: number }>();
  let totalLoc = 0;

  for (let idx = 0; idx < paths.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) await yieldToEventLoop();
    const full = paths[idx];
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
export interface ImportGraph {
  fanIn: Map<string, number>;
  importEdges: Array<{ from: string; to: string }>;
}

export async function computeImportGraph(files: ScannedFile[]): Promise<ImportGraph> {
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
    if (idx > 0 && idx % YIELD_EVERY === 0) await yieldToEventLoop();
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
