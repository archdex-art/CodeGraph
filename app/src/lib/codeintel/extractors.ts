import { astTsExtractor } from "./ast-extractor";
import type { SymbolKind } from "../types";

// A raw symbol before graph-level resolution (fanIn/fanOut/edges added later).
export interface RawSymbol {
  name: string;
  kind: SymbolKind;
  line: number; // 1-indexed
  endLine: number;
  signature: string;
  doc: string | null;
  exported: boolean;
  container: string | null; // local container name (class) for nesting
}

export interface RawReference {
  name: string;
  line: number; // 1-indexed, the line the call occurs on — lets graph.ts attribute
  resolvedTargetId?: string; // Set by type-aware extractors to bypass heuristic resolution
  // it to the enclosing function/method instead of guessing at the file level.
}

// A local import binding: `localName` resolves to `importedName` exported
// from `modulePath` (as written in source — relative paths are resolved
// against the file's own location in graph.ts; bare specifiers, e.g. "react",
// are left unresolved and fall through to same-file/global name search).
export interface RawImport {
  localName: string;
  importedName: string; // "*" for `import * as ns from "..."` (namespace)
  modulePath: string;
}
export interface ExtractContext {
  text: string;
  relPath: string;
  program?: any; // ts.Program if available
}

export interface LanguageExtractor {
  language: string;
  exts: string[];
  extract(ctx: ExtractContext): ExtractResult;
}

export interface ExtractResult {
  symbols: RawSymbol[];
  references: RawReference[];
  imports: RawImport[];
}


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
const IMPORT_RE = /^import\s+(?:type\s+)?(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s*as\s+([A-Za-z0-9_$]+))?\s*(?:from\s+)?["']([^"']+)["']/;
function collectImports(lines: string[]): RawImport[] {
  const out: RawImport[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.startsWith("import ")) continue;
    const m = l.match(IMPORT_RE);
    if (!m) continue;
    const [, defaultName, named, namespaceName, modulePath] = m;
    if (defaultName) out.push({ localName: defaultName, importedName: "default", modulePath });
    if (namespaceName) out.push({ localName: namespaceName, importedName: "*", modulePath });
    if (named) {
      for (const part of named.split(",")) {
        const p = part.trim();
        if (!p) continue;
        const asMatch = p.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        if (asMatch) out.push({ localName: asMatch[2], importedName: asMatch[1], modulePath });
        else out.push({ localName: p, importedName: p, modulePath });
      }
    }
  }
  return out;
}

// ---- TypeScript / JavaScript ----

const JS_KEYWORDS: Record<string, true> = {
  if: true, for: true, while: true, switch: true, catch: true, return: true,
  function: true, await: true, typeof: true, super: true, new: true, in: true, of: true,
};

const tsExtractor: LanguageExtractor = {
  language: "TypeScript",
  exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  extract(ctx: ExtractContext) {
    const lines = ctx.text.split("\n");
    const symbols: RawSymbol[] = [];
    let classContext: { name: string; endLine: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const l = raw.trim();
      if (classContext && i + 1 > classContext.endLine) classContext = null;

      const exported = /^export\b/.test(l) || /^export\s+default\b/.test(l);

      // class / interface / type / enum
      let m =
        l.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class)\s+([A-Za-z0-9_$]+)/) ||
        l.match(/^(?:export\s+)?(interface)\s+([A-Za-z0-9_$]+)/) ||
        l.match(/^(?:export\s+)?(enum)\s+([A-Za-z0-9_$]+)/);
      if (m) {
        const kind = m[1] as SymbolKind;
        const end = kind === "interface" || kind === "enum" ? braceEnd(lines, i) : braceEnd(lines, i);
        symbols.push({ name: m[2], kind, line: i + 1, endLine: end, signature: l.replace(/\s*\{.*$/, ""), doc: docAbove(lines, i, "js"), exported, container: null });
        if (kind === "class") classContext = { name: m[2], endLine: end };
        continue;
      }
      m = l.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
      if (m) {
        symbols.push({ name: m[1], kind: "type", line: i + 1, endLine: i + 1, signature: l.replace(/;$/, ""), doc: docAbove(lines, i, "js"), exported, container: null });
        continue;
      }
      m = l.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*(\([^)]*\))/);
      if (m) {
        symbols.push({ name: m[1], kind: "function", line: i + 1, endLine: braceEnd(lines, i), signature: `function ${m[1]}${m[2]}`, doc: docAbove(lines, i, "js"), exported, container: null });
        continue;
      }
      // const foo = (…) => / arrow & function expr
      m = l.match(/^(?:export\s+)?(?:default\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/) ||
          l.match(/^(?:export\s+)?(?:default\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?function/);
      if (m) {
        const isComponent = /^[A-Z]/.test(m[1]) && (ctx.text.includes("react") || ctx.text.includes("jsx") || /\.(tsx|jsx)$/.test(""));
        symbols.push({ name: m[1], kind: isComponent ? "component" : "function", line: i + 1, endLine: braceEnd(lines, i), signature: l.replace(/\s*=>.*$/, " =>").slice(0, 120), doc: docAbove(lines, i, "js"), exported, container: null });
        continue;
      }
      // exported const value
      m = l.match(/^export\s+const\s+([A-Za-z0-9_$]+)\s*[:=]/);
      if (m) {
        symbols.push({ name: m[1], kind: "constant", line: i + 1, endLine: i + 1, signature: l.slice(0, 120), doc: docAbove(lines, i, "js"), exported: true, container: null });
        continue;
      }

      // class methods
      if (classContext) {
        const mm = raw.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|readonly\s+)*([A-Za-z0-9_$]+)\s*(\([^)]*\))\s*(?::[^={]+)?\{/);
        if (mm && !JS_KEYWORDS[mm[1]]) {
          symbols.push({ name: mm[1], kind: "method", line: i + 1, endLine: braceEnd(lines, i), signature: `${mm[1]}${mm[2]}`, doc: docAbove(lines, i, "js"), exported: classContext ? true : false, container: classContext.name });
        }
      }
    }
    return { symbols, references: collectRefs(lines), imports: collectImports(lines) };
  },
};

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

const REGISTRY: LanguageExtractor[] = [astTsExtractor(tsExtractor), pyExtractor];
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
