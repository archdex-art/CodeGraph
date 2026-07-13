import type { CodeSymbol, SymbolEdge, SymbolGraph, SymbolKind } from "../types";
import { posix } from "node:path";
import ts from "typescript";
import { extractorFor, type RawImport, type RawReference } from "./extractors";

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

// Extensions probed when resolving a relative import specifier to an actual
// file (mirrors Node/bundler module resolution closely enough for repo-local
// imports; bare specifiers like "react" are left unresolved on purpose --
// they're external packages, not files in this graph).
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

function resolveModulePath(fromFile: string, spec: string, knownFiles: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = posix.dirname(fromFile);
  const joined = posix.normalize(posix.join(dir, spec));
  if (knownFiles.has(joined)) return joined;
  for (const ext of RESOLVE_EXTS) if (knownFiles.has(joined + ext)) return joined + ext;
  for (const ext of RESOLVE_EXTS) {
    const idx = posix.join(joined, "index" + ext);
    if (knownFiles.has(idx)) return idx;
  }
  return null;
}

// Smallest symbol (by line span) among candidates whose [line, endLine] range
// contains `line` -- the innermost enclosing function/method for a call site,
// replacing the old "attribute every call to the file's first function"
// approximation now that references carry a line number.
function findEnclosingCaller(candidates: CodeSymbol[], line: number, excludeId: string): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const s of candidates) {
    if (s.id === excludeId) continue;
    if (line < s.line || line > s.endLine) continue;
    if (!best || s.endLine - s.line < best.endLine - best.line) best = s;
  }
  return best;
}
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
  // Track symbols per file for import resolution
  const byFile = new Map<string, Map<string, CodeSymbol>>();
  const knownFiles = new Set<string>();

  // per-file: list of (symbol, localName) to resolve container + own refs
  const fileRefs: Array<{ file: string; refs: RawReference[]; imports: RawImport[]; symbolsInFile: CodeSymbol[] }> = [];
  // Optional: Build a TS program for type-aware resolution
  const tsFiles = files.filter(f => /.(ts|tsx|js|jsx|cjs|mjs)$/.test(f.ext));
  let program: ts.Program | undefined;
  if (tsFiles.length > 0) {
    const options: ts.CompilerOptions = { allowJs: true, target: ts.ScriptTarget.Latest, moduleResolution: ts.ModuleResolutionKind.Node10 };
    const host = ts.createCompilerHost(options);
    const fileMap = new Map(files.map(f => [f.rel, f.text]));
    const origGetSourceFile = host.getSourceFile;
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (fileMap.has(fileName)) return ts.createSourceFile(fileName, fileMap.get(fileName)!, languageVersion);
      return origGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };
    host.readFile = (fileName) => fileMap.get(fileName) || ts.sys.readFile(fileName);
    host.fileExists = (fileName) => fileMap.has(fileName) || ts.sys.fileExists(fileName);
    program = ts.createProgram(tsFiles.map(f => f.rel), options, host);
  }

  for (const f of files) {
    knownFiles.add(f.rel);
    const ex = extractorFor(f.ext);
    if (!ex) continue;
    const { symbols: raws, references, imports } = ex.extract({ text: f.text, relPath: f.rel, program });
    const inFile: CodeSymbol[] = [];
    // container name -> id within this file
    const containerId = new Map<string, string>();
    const localMap = new Map<string, CodeSymbol>();

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
        complexity: (r as any).complexity,
        container: null,
        fanIn: 0,
        fanOut: 0,
        issues: 0,
        tags: tagsFor(r.name, r.signature, r.doc),
      };
      symbols.push(sym);
      inFile.push(sym);
      localMap.set(r.name, sym);

      if (r.kind === "class" || r.kind === "interface") containerId.set(r.name, id);
      const list = defsByName.get(r.name) || [];
      // Prefer exported symbols in the global fallback list
      if (sym.exported) list.unshift(id);
      else list.push(id);
      defsByName.set(r.name, list);
      
      // stash local container name to link after
      (sym as CodeSymbol & { _container?: string })._container = r.container ?? undefined;
    }

    byFile.set(f.rel, localMap);

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

    fileRefs.push({ file: f.rel, refs: references, imports: imports || [], symbolsInFile: inFile });
    // attribute file-level issue counts to the largest symbol spanning nothing precise: keep on file
  }

  // Attribute issues to symbols by file (coarse: file issue count spread is skipped; store 0, UI uses file issues elsewhere)
  void issuesByFile;

  // Pass 2: resolve references -> CALLS edges.
  let resolvedCalls = 0;
  const edgeCounts = new Map<string, number>();
  const symbolById = new Map<string, CodeSymbol>();
  for (const s of symbols) symbolById.set(s.id, s);

  for (const fr of fileRefs) {
    const localNames = byFile.get(fr.file) || new Map<string, CodeSymbol>();
    
    // Build import binding map for this file
    const importBindings = new Map<string, { importedName: string; resolvedFile: string }>();
    for (const imp of fr.imports) {
      const resolvedFile = resolveModulePath(fr.file, imp.modulePath, knownFiles);
      if (resolvedFile) {
        importBindings.set(imp.localName, { importedName: imp.importedName, resolvedFile });
      }
    }
    for (const ref of fr.refs) {
      const name = ref.name;
      let targetSym: CodeSymbol | null = null;

      // 0. Type-aware resolution (bypasses heuristics if TS compiler found the exact target)
      if (ref.resolvedTargetId) {
        targetSym = symbolById.get(ref.resolvedTargetId) || null;
      }

      // 1. Same-file local
      if (!targetSym && localNames.has(name)) {
        targetSym = localNames.get(name)!;
      } 
      // 2. Import binding (exact file)
      else if (importBindings.has(name)) {
        const binding = importBindings.get(name)!;
        const targetLocalMap = byFile.get(binding.resolvedFile);
        if (targetLocalMap) {
          if (binding.importedName === "default") {
            // Try to find the default export, or fall back to any exported symbol
            const targetSymbols = Array.from(targetLocalMap.values());
            targetSym = targetSymbols.find(s => s.exported) || targetSymbols[0] || null;
          } else if (binding.importedName !== "*") {
            targetSym = targetLocalMap.get(binding.importedName) || null;
          }
        }
      } 
      
      // 3. Global fallback
      if (!targetSym) {
        const defs = defsByName.get(name);
        if (defs && defs.length) {
          targetSym = symbolById.get(defs[0]) || null;
        }
      }

      if (!targetSym) continue;

      // Caller attribution: smallest enclosing function/method/component
      const callerCandidates = fr.symbolsInFile.filter(s => s.kind === "function" || s.kind === "method" || s.kind === "component");
      const caller = findEnclosingCaller(callerCandidates, ref.line, targetSym.id);
      
      if (!caller || caller.id === targetSym.id) continue;

      const key = `${caller.id}->${targetSym.id}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }

  for (const [key, count] of edgeCounts.entries()) {
    const [source, target] = key.split("->"); // safe because our IDs don't have "->"
    edges.push({ source, target, kind: "calls" });
    const s = symbolById.get(source)!;
    const t = symbolById.get(target)!;
    s.fanOut += 1;
    t.fanIn += Math.min(count, 5); // cap at 5 per distinct caller to prevent massive spam from one file
    resolvedCalls++;
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
