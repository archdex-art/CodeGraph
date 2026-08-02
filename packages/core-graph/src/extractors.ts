import { astTsExtractor } from "./ast-extractor";

// The extractor contract lives in `./contracts` so that `ast-extractor.ts` can
// depend on it without depending back on this module — see the note there.
// Re-exported so existing importers of these names keep working.
export type {
  ExtractContext,
  ExtractResult,
  LanguageExtractor,
  RawImport,
  RawReference,
  RawSymbol,
} from "./contracts";

import type { SymbolKind } from "./symbol";
import type { ExtractContext, ExtractResult, LanguageExtractor, RawImport, RawReference, RawSymbol } from "./contracts";


// ---- shared helpers ----

function docAbove(lines: string[], idx: number, style: "js" | "py"): string | null {
  const out: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (style === "js") {
      if (l.endsWith("*/") || l.startsWith("*") || l.startsWith("/**") || l.startsWith("//")) {
        out.unshift(l.replace(/^\/\*\*?|\*\/$|^\*\s?|^\/\/\s?/g, "").trim());
        if (l.startsWith("/**")) break;
        continue;
      }
    } else if (l.startsWith("#")) {
      out.unshift(l.replace(/^#\s?/, ""));
      continue;
    }
    break;
  }
  const doc = out.filter(Boolean).join(" ").trim();
  return doc.length > 2 ? doc.slice(0, 300) : null;
}

// Rough block end by brace balance (js-family) starting at a line.
function braceEnd(lines: string[], start: number): number {
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length && i < start + 800; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; seen = true; }
      else if (ch === "}") { depth--; }
    }
    if (seen && depth <= 0) return i + 1;
  }
  return Math.min(lines.length, start + 1);
}

// Indent-based block end (python).
function indentEnd(lines: string[], start: number): number {
  const base = lines[start].match(/^(\s*)/)![1].length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ind = lines[i].match(/^(\s*)/)![1].length;
    if (ind <= base) return i;
  }
  return lines.length;
}

// One entry per call occurrence (not aggregated) so graph.ts can attribute
// each call to whichever function/method actually contains that line,
// instead of guessing at the file level.
const REF_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
function collectRefs(lines: string[]): RawReference[] {
  const out: RawReference[] = [];
  for (let i = 0; i < lines.length; i++) {
    REF_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = REF_RE.exec(lines[i]))) {
      const name = r[1];
      if (name.length < 2) continue;
      out.push({ name, line: i + 1 });
    }
  }
  return out;
}

// ---- shared import parsing (ES module syntax; TS `import type` included —
// harmless for call resolution since types are never call targets) ----
// The regex TypeScript/JavaScript extractor, `IMPORT_RE` and `collectImports` were deleted.
// `astTsExtractor` took the extractor as a `fallback` and never called it: `createSourceFile`
// returns a tree with diagnostics rather than throwing, so there was no path on which the
// fallback could run. It had been unreachable for every .ts/.js file, which is why a CommonJS
// fix written into it earlier in this branch had no effect at all.

// ---- Python ----
// Import CAPTURE only, no path resolution in graph.ts yet (Python package/module
// -> file path resolution, `__init__.py`, relative dots, etc. is materially more
// involved than JS's extension-probing and is out of scope for this pass — see
// docs/IMPROVEMENT_PLAN.md Phase 6.2). Captured so a future pass can wire it up
// without touching this extractor again.
const PY_IMPORT_RE = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$|^import\s+([\w.]+)(?:\s+as\s+(\w+))?/;
function collectPyImports(lines: string[]): RawImport[] {
  const out: RawImport[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    const m = l.match(PY_IMPORT_RE);
    if (!m) continue;
    const [, fromModule, namedList, plainModule, plainAlias] = m;
    if (fromModule !== undefined) {
      for (const part of namedList.split(",")) {
        const p = part.trim();
        if (!p || p === "*") continue;
        const asMatch = p.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) out.push({ localName: asMatch[2], importedName: asMatch[1], modulePath: fromModule });
        else out.push({ localName: p, importedName: p, modulePath: fromModule });
      }
    } else if (plainModule) {
      const local = plainAlias || plainModule.split(".")[0];
      out.push({ localName: local, importedName: "*", modulePath: plainModule });
    }
  }
  return out;
}

const pyExtractor: LanguageExtractor = {
  language: "Python",
  exts: [".py"],
  extract(ctx: ExtractContext) {
    const lines = ctx.text.split("\n");
    const symbols: RawSymbol[] = [];
    let classContext: { name: string; endLine: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const l = raw.trim();
      if (classContext && i >= classContext.endLine) classContext = null;

      let m = l.match(/^class\s+([A-Za-z0-9_]+)/);
      if (m) {
        const end = indentEnd(lines, i);
        symbols.push({ name: m[1], kind: "class", line: i + 1, endLine: end, signature: l.replace(/:$/, ""), doc: docAbove(lines, i, "py"), exported: !m[1].startsWith("_"), container: null });
        classContext = { name: m[1], endLine: end };
        continue;
      }
      m = raw.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/);
      if (m) {
        const indented = m[1].length > 0;
        symbols.push({
          name: m[2],
          kind: indented && classContext ? "method" : "function",
          line: i + 1,
          endLine: indentEnd(lines, i),
          signature: `def ${m[2]}${m[3]}`,
          doc: docAbove(lines, i, "py"),
          exported: !m[2].startsWith("_"),
          container: indented && classContext ? classContext.name : null,
        });
      }
    }
    return { symbols, references: collectRefs(lines), imports: collectPyImports(lines) };
  },
};

// ---- registry ----

const REGISTRY: LanguageExtractor[] = [astTsExtractor(), pyExtractor];
const byExt = new Map<string, LanguageExtractor>();
for (const ex of REGISTRY) {
  for (const e of ex.exts) {
    // first one wins, so astTsExtractor overrides tsExtractor if registered first
    if (!byExt.has(e)) byExt.set(e, ex);
  }
}

export function extractorFor(ext: string): LanguageExtractor | null {
  return byExt.get(ext) ?? null;
}

export function supportedExts(): string[] {
  return [...byExt.keys()];
}
