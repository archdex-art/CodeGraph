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

export interface ExtractResult {
  symbols: RawSymbol[];
  // Bare call/reference tokens seen in the file (name -> count), used for edge resolution.
  references: Map<string, number>;
}

/**
 * A LanguageExtractor turns source text into structural symbols + reference tokens.
 * This is the pluggable seam (Open/Closed): add a language by registering an extractor,
 * downstream graph/query/context code is untouched. Tree-sitter/LSP can later implement
 * this same interface for higher fidelity without changing consumers.
 */
export interface LanguageExtractor {
  language: string;
  exts: string[];
  extract(text: string): ExtractResult;
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

const REF_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
function collectRefs(text: string): Map<string, number> {
  const m = new Map<string, number>();
  let r: RegExpExecArray | null;
  while ((r = REF_RE.exec(text))) {
    const name = r[1];
    if (name.length < 2) continue;
    m.set(name, (m.get(name) || 0) + 1);
  }
  return m;
}

// ---- TypeScript / JavaScript ----

const JS_KEYWORDS: Record<string, true> = {
  if: true, for: true, while: true, switch: true, catch: true, return: true,
  function: true, await: true, typeof: true, super: true, new: true, in: true, of: true,
};

const tsExtractor: LanguageExtractor = {
  language: "TypeScript",
  exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  extract(text) {
    const lines = text.split("\n");
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

      // function declarations
      m = l.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*(\([^)]*\))/);
      if (m) {
        symbols.push({ name: m[1], kind: "function", line: i + 1, endLine: braceEnd(lines, i), signature: `function ${m[1]}${m[2]}`, doc: docAbove(lines, i, "js"), exported, container: null });
        continue;
      }
      // const foo = (…) => / arrow & function expr
      m = l.match(/^(?:export\s+)?(?:default\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/) ||
          l.match(/^(?:export\s+)?(?:default\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?function/);
      if (m) {
        const isComponent = /^[A-Z]/.test(m[1]) && (text.includes("react") || text.includes("jsx") || /\.(tsx|jsx)$/.test(""));
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
    return { symbols, references: collectRefs(text) };
  },
};

// ---- Python ----

const pyExtractor: LanguageExtractor = {
  language: "Python",
  exts: [".py"],
  extract(text) {
    const lines = text.split("\n");
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
    return { symbols, references: collectRefs(text) };
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
