import type { CodeSymbol, SymbolEdge, SymbolGraph, SymbolKind } from "../types";
import { extractorFor } from "./extractors";

export interface FileInput {
  rel: string; // posix path relative to root
  ext: string;
  text: string;
  language: string;
}

const MAX_SYMBOLS = 6000;

// Lightweight semantic tagging from name/signature/doc (the "concepts" layer).
const TAG_RULES: Array<{ tag: string; re: RegExp }> = [
  { tag: "auth", re: /\b(auth|login|logout|session|token|jwt|password|credential|oauth|permission)\b/i },
  { tag: "db", re: /\b(db|database|query|sql|repository|model|schema|migration|orm|prisma|sqlite|postgres)\b/i },
  { tag: "http", re: /\b(http|request|response|route|controller|endpoint|api|fetch|axios|handler|middleware)\b/i },
  { tag: "ui", re: /\b(render|component|view|button|modal|page|props|state|hook|css|style)\b/i },
  { tag: "test", re: /\b(test|spec|mock|fixture|assert|expect|describe)\b/i },
  { tag: "crypto", re: /\b(hash|encrypt|decrypt|cipher|sign|verify|crypto|secret)\b/i },
  { tag: "io", re: /\b(read|write|file|stream|buffer|fs|path|serialize|parse|json)\b/i },
  { tag: "config", re: /\b(config|setting|env|option|flag|constant|default)\b/i },
  { tag: "error", re: /\b(error|exception|throw|catch|fail|panic|validate|validation)\b/i },
];

function tagsFor(name: string, signature: string, doc: string | null): string[] {
  const hay = `${name} ${signature} ${doc || ""}`;
  const tags: string[] = [];
  for (const { tag, re } of TAG_RULES) if (re.test(hay)) tags.push(tag);
  return tags;
}

const symId = (file: string, name: string, line: number) => `${file}#${name}@${line}`;

/**
 * Build the symbol-level knowledge graph across all files.
 * Pass 1: extract symbols + local refs per file.
 * Pass 2: resolve references to definitions -> CALLS edges + fan-in/out.
 */
export function buildSymbolGraph(files: FileInput[], issuesByFile: Map<string, number>): SymbolGraph {
  const symbols: CodeSymbol[] = [];
  const edges: SymbolEdge[] = [];
  // name -> symbol ids (for cross-file resolution; multiple defs possible)
  const defsByName = new Map<string, string[]>();
  // symbol id -> reference token counts (for pass 2)
  const refsBySymbol = new Map<string, Map<string, number>>();
  // per-file: list of (symbol, localName) to resolve container + own refs
  const fileRefs: Array<{ file: string; refs: Map<string, number>; symbolsInFile: CodeSymbol[] }> = [];

  for (const f of files) {
    const ex = extractorFor(f.ext);
    if (!ex) continue;
    const { symbols: raws, references } = ex.extract(f.text);
    const inFile: CodeSymbol[] = [];
    // container name -> id within this file
    const containerId = new Map<string, string>();

    for (const r of raws) {
      if (symbols.length >= MAX_SYMBOLS) break;
      const id = symId(f.rel, r.name, r.line);
      const sym: CodeSymbol = {
        id,
        name: r.name,
        kind: r.kind as SymbolKind,
        file: f.rel,
        line: r.line,
        endLine: r.endLine,
        signature: r.signature,
        doc: r.doc,
        exported: r.exported,
        language: ex.language,
        loc: Math.max(1, r.endLine - r.line + 1),
        container: null,
        fanIn: 0,
        fanOut: 0,
        issues: 0,
        tags: tagsFor(r.name, r.signature, r.doc),
      };
      symbols.push(sym);
      inFile.push(sym);
      if (r.kind === "class" || r.kind === "interface") containerId.set(r.name, id);
      const list = defsByName.get(r.name) || [];
      list.push(id);
      defsByName.set(r.name, list);
      // stash local container name to link after
      (sym as CodeSymbol & { _container?: string })._container = r.container ?? undefined;
    }

    // CONTAINS edges (class -> method) within file
    for (const sym of inFile) {
      const c = (sym as CodeSymbol & { _container?: string })._container;
      if (c && containerId.has(c)) {
        const cid = containerId.get(c)!;
        sym.container = cid;
        edges.push({ source: cid, target: sym.id, kind: "contains" });
      }
      delete (sym as CodeSymbol & { _container?: string })._container;
    }

    fileRefs.push({ file: f.rel, refs: references, symbolsInFile: inFile });
    // attribute file-level issue counts to the largest symbol spanning nothing precise: keep on file
  }

  // Attribute issues to symbols by file (coarse: file issue count spread is skipped; store 0, UI uses file issues elsewhere)
  void issuesByFile;

  // Pass 2: resolve references -> CALLS edges.
  // A file's ref tokens resolve to defs (prefer same-file, then exported cross-file).
  let resolvedCalls = 0;
  const seenEdge = new Set<string>();
  for (const fr of fileRefs) {
    const localNames = new Map<string, string>(); // name -> id (defs in this file)
    for (const s of fr.symbolsInFile) localNames.set(s.name, s.id);
    // The "caller" for a ref is the enclosing symbol; approximate by nearest preceding symbol.
    const ordered = [...fr.symbolsInFile].sort((a, b) => a.line - b.line);

    for (const [name, count] of fr.refs) {
      // resolve target
      let targetId: string | null = null;
      if (localNames.has(name) ) targetId = localNames.get(name)!;
      else {
        const defs = defsByName.get(name);
        if (defs && defs.length) {
          // prefer an exported def in another file
          targetId = defs.find((id) => id !== undefined) || null;
        }
      }
      if (!targetId) continue;
      const target = symbols.find((s) => s.id === targetId);
      if (!target) continue;

      // pick caller = last symbol defined before... we don't have ref line; attribute to file's top exported symbol
      // Better: attribute call to every symbol in file whose body could contain it is expensive; use file's primary symbol.
      const caller = ordered.find((s) => s.id !== targetId && (s.kind === "function" || s.kind === "method" || s.kind === "component")) || ordered[0];
      if (!caller || caller.id === targetId) continue;

      const key = caller.id + "->" + targetId;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ source: caller.id, target: targetId, kind: "calls" });
      caller.fanOut += 1;
      target.fanIn += Math.min(count, 5);
      resolvedCalls++;
    }
  }

  const truncated = symbols.length >= MAX_SYMBOLS;
  return {
    symbols,
    edges,
    truncated,
    stats: { symbols: symbols.length, edges: edges.length, resolvedCalls },
  };
}

export { symId };
