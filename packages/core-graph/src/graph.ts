import type { CodeSymbol, SymbolEdge, SymbolGraph, SymbolKind } from "./symbol";
import { posix, resolve as resolvePath, sep as pathSep } from "node:path";
import ts from "typescript";
import { extractorFor, type ExtractResult, type RawImport, type RawReference } from "./extractors";

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
//
// The callee is deliberately NOT excluded from the candidates. It used to be, and that made
// recursion produce a confidently wrong answer rather than no answer: for
// `function fact(n) { return n * fact(n - 1); }` the innermost enclosing context IS `fact`,
// so excluding it fell through to the next-outer context and recorded
// `<module> -calls-> fact`. The module does not call `fact`; `fact` does. That one wrong edge
// then produced a synthetic `<module>` node nothing needed, inflated `fact`'s fan-in with a
// caller that does not exist, and hid every self-recursive cycle from `cycles()`. A nested
// helper recursing inside an outer function was attributed to the OUTER function, which is
// worse: a real symbol named as a caller that never makes the call.
function findEnclosingCaller(candidates: CodeSymbol[], line: number): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const s of candidates) {
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
const YIELD_EVERY = 15;
function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Pass-1 output for one file: what the extractor found, before anything cross-file happens.
 *
 * This is the unit the incremental index reuses, and the reason it CAN be reused is narrow
 * and worth stating: `symbols` and `imports` are functions of the file's own text, while
 * `references[].resolvedTargetId` is not — it names a declaration in another file, resolved
 * through the type checker. So a content hash alone is an unsound key (the note on
 * `content-cache.ts` says exactly this, and is why extraction was left out of that cache).
 *
 * The sound key is content PLUS the transitive import closure, and computing that is the
 * caller's job — `@codegraph/analysis` owns it, because it is the layer that has the import
 * graph. This module only honours the decision: `invalidated` says which files the caller
 * could not prove unchanged, and everything else may come from `reuse`.
 */
export type ExtractionRecord = ExtractResult;

export interface SymbolGraphOptions {
  /** Pass-1 results from a previous run, keyed by repo-relative posix path. */
  reuse?: ReadonlyMap<string, ExtractionRecord>;
  /**
   * Files that MUST be re-extracted. Absent means "all of them" — the safe reading, so a
   * caller that forgets to compute a closure gets a correct full build rather than a stale
   * graph. The TypeScript program is built over exactly these files, which is where the
   * saving comes from: it is ~74% of this stage (923ms of 1,255ms measured on this repo) and
   * it is proportional to the number of root files, not to the size of the repository.
   */
  invalidated?: ReadonlySet<string>;
  /**
   * Filled with the extraction used for EVERY file, reused or fresh, so the caller can
   * persist a complete manifest. Complete rather than incremental on purpose: a cache that
   * only ever accumulates deltas cannot express a deletion.
   */
  out?: Map<string, ExtractionRecord>;
}

export async function buildSymbolGraph(
  files: FileInput[],
  issuesByFile: Map<string, number>,
  root?: string,
  opts?: SymbolGraphOptions,
): Promise<SymbolGraph> {
  const symbols: CodeSymbol[] = [];
  const edges: SymbolEdge[] = [];
  // name -> symbol ids (for cross-file resolution; multiple defs possible)
  const defsByName = new Map<string, string[]>();
  // Track symbols per file for import resolution
  const byFile = new Map<string, Map<string, CodeSymbol>>();
  const knownFiles = new Set<string>();

  // per-file: list of (symbol, localName) to resolve container + own refs
  const fileRefs: Array<{ file: string; refs: RawReference[]; imports: RawImport[]; symbolsInFile: CodeSymbol[] }> = [];
  /**
   * Build a TS program for type-aware resolution.
   *
   * **Two defects that only matter together.** Measured on this repository, type-aware
   * resolutions that actually hit a symbol: 1,094 before, 2,167 after.
   *
   * 1. `createProgram` was given RELATIVE rootNames while `getCurrentDirectory()` reported the
   *    real cwd, so module resolution probed paths the in-memory map was not keyed by and
   *    cross-file imports did not resolve. Fixing this alone: 1,094 -> 1,700.
   * 2. `getSymbolAtLocation` on an imported identifier yields an ALIAS whose declaration is
   *    the import statement in the CALLING file (see `ast-extractor.ts`). Fixing this alone:
   *    1,094 -> 1,099 - nearly nothing, because without (1) there was no resolution to
   *    de-alias. Together: 2,167.
   *
   * A `directoryExists` override was tried here and REMOVED: it changed the count by exactly
   * 0. An isolated `ts.resolveModuleName` call does need it, which is why it looked necessary;
   * inside `createProgram` every file is already a root name, so the probe never happens.
   *
   * The result was not wrong edges - it was `resolvedTargetId`s naming symbols that exist in
   * no file, missing the map, and falling through to name-based heuristics in total silence.
   * The heuristics are good enough that the graph looked fine, which is why this survived.
   *
   * `root` is the repo directory. Given it, paths are real, so `node_modules` and `@types`
   * resolve too. Absent (unit tests construct files in memory), a synthetic base keeps
   * resolution working between the supplied files, which is all such a test has.
   *
   * **Do not delete this to make the stage faster.** Measured 2026-07-30 on this repository:
   * the program costs ~923ms of a ~1,255ms `symbol-graph` stage — 38% of a whole run — and
   * changes SIX edges out of 2,549 (0.24%). Every number says remove it. Removing it is wrong.
   *
   * Those six are all the same shape: a method call through a receiver
   * (`this.config.childEnv(...)`, `contentCache.clear()`) where the method name also exists as
   * a free function in some other file. The name never appears in an import, so the fallback's
   * import table cannot help and it picks the other file. It does not lose the edge — it
   * emits a confident wrong one, and a wrong edge in a graph product is worse than a gap,
   * because the graph is the product.
   *
   * `tests/typed-resolution.test.ts` pins exactly this, and fails if the program is skipped or
   * the base goes synthetic. Written twice: the first version used an imported free function
   * and passed with the program deleted.
   *
   * Also measured, for the neighbouring idea: parsing all 329 TS files costs 58ms while the
   * program costs ~802ms, so caching extracted symbols per content hash cannot pay — parsing
   * was never the expense.
   *
   * And for the idea after that: passing this program as `oldProgram` on the next run DOES
   * work — `structureIsReused` reaches `Completely`, warm cost 1,125ms -> ~320ms with identical
   * resolutions. It is not done because holding the program holds every `SourceFile` and the
   * checker: 528 MB of retained heap, 842 MB RSS, on a 512 MB target. A cold run allocates
   * comparable memory and gives it back; reuse never gives it back. See PLAN.md.
   */
  const tsFiles = files.filter(f => /\.(ts|tsx|js|jsx|cjs|mjs)$/.test(f.ext));
  const base = (root ? resolvePath(root) : "/__codegraph__").split(pathSep).join("/");
  const absOf = (rel: string) => `${base}/${rel}`;
  /**
   * A file is extracted afresh unless the caller both offered a cached record for it AND did
   * not list it as invalidated. Missing from `reuse` therefore means "extract" — a file added
   * since the cached run has no record and must never be silently skipped.
   */
  const reuse = opts?.reuse;
  const invalidated = opts?.invalidated;
  const mustExtract = (rel: string): boolean =>
    !reuse?.has(rel) || invalidated === undefined || invalidated.has(rel);
  /**
   * Program roots are the files being re-extracted, not the whole repository.
   *
   * The checker only has to answer questions about files we actually ask it about; the
   * remaining texts stay in `fileMap` so that imports out of a root file still resolve to
   * repo files rather than to disk. On a one-file edit this turns the dominant cost of the
   * stage into "parse that file and its transitive imports".
   */
  const programRoots = tsFiles.filter(f => mustExtract(f.rel));
  let program: ts.Program | undefined;
  if (programRoots.length > 0) {
    const options: ts.CompilerOptions = { allowJs: true, target: ts.ScriptTarget.Latest, moduleResolution: ts.ModuleResolutionKind.Node10 };
    const host = ts.createCompilerHost(options);
    const fileMap = new Map(files.map(f => [absOf(f.rel), f.text]));
    const origGetSourceFile = host.getSourceFile;
    host.getCurrentDirectory = () => base;
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (fileMap.has(fileName)) return ts.createSourceFile(fileName, fileMap.get(fileName)!, languageVersion);
      return origGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    };
    host.readFile = (fileName) => fileMap.get(fileName) ?? ts.sys.readFile(fileName);
    host.fileExists = (fileName) => fileMap.has(fileName) || ts.sys.fileExists(fileName);
    program = ts.createProgram(programRoots.map(f => absOf(f.rel)), options, host);
  }

  /**
   * Symbol ids are repo-relative while the checker answers in absolute program paths, so a
   * cached `resolvedTargetId` would only be meaningful under the root it was produced for.
   * Stripped once, here, rather than at every use: it makes the persisted record independent
   * of where the repository happens to be checked out, which matters because the remediation
   * executor indexes a COPY of the tree in a sandbox directory.
   */
  const stripBase = (id: string): string => (id.startsWith(`${base}/`) ? id.slice(base.length + 1) : id);

  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) await yieldToEventLoop();
    const f = files[idx];
    knownFiles.add(f.rel);
    const ex = extractorFor(f.ext);
    if (!ex) continue;
    let record: ExtractionRecord;
    if (mustExtract(f.rel)) {
      record = ex.extract({ text: f.text, relPath: f.rel, programPath: absOf(f.rel), program });
      for (const r of record.references) {
        if (r.resolvedTargetId) r.resolvedTargetId = stripBase(r.resolvedTargetId);
      }
    } else {
      record = reuse!.get(f.rel)!;
    }
    opts?.out?.set(f.rel, record);
    const { symbols: raws, references, imports } = record;
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

  /**
   * Module scope as a first-class caller.
   *
   * A call site's source used to be a PARTIAL function: only a call lexically inside a named
   * function/method/component produced an edge, and everything else was dropped at the
   * `!caller` guard below. Measured on this repository before the change: **2,313 of 5,025
   * resolved calls - 46% - were discarded**, and 2,099 of those were at module scope proper
   * (the remaining 214 sat inside a symbol of a kind the filter excluded, such as an arrow
   * function held in a `const`).
   *
   * The consequence was not a missing arrow here and there. A function called only from a
   * top-level statement, a `describe`/`it` callback, or an object literal had fan-in 0 and was
   * reported as DEAD CODE. `rep` in `pillars.test.ts` is called four times in its own file and
   * the graph showed no callers at all.
   *
   * Source is now total: every call site has an enclosing execution context, and at worst that
   * context is the module body, which really does execute on import. Modelling it as a node is
   * the standard move - Python's `<module>` frame, the JVM's `<clinit>`, LLVM's module
   * constructors - not an invention to paper over the gap.
   *
   * Created lazily, so a file with no module-scope calls gains no node, and `kind: "module"`
   * keeps these out of `deadCode()` (which filters to functions and methods) - a module is
   * never dead code, and auto-generating hundreds of unreferenced nodes would have traded one
   * false signal for another.
   */
  const languageOf = new Map(files.map(f => [f.rel, f.language]));
  const moduleSymbolOf = (file: string): CodeSymbol => {
    const id = `${file}#<module>@0`;
    const existing = symbolById.get(id);
    if (existing) return existing;
    const sym: CodeSymbol = {
      id,
      name: "<module>",
      kind: "module",
      file,
      line: 1,
      endLine: 1,
      signature: `<module> ${file}`,
      doc: null,
      exported: false,
      container: null,
      fanIn: 0,
      fanOut: 0,
      issues: 0,
      tags: [],
      // Zero-width by construction: the node stands for the file's top-level body, not a span
      // of it, and giving it the file's line count would double-count that file's size.
      loc: 0,
      language: languageOf.get(file) ?? "unknown",
    };
    symbols.push(sym);
    symbolById.set(id, sym);
    return sym;
  };

  for (let idx = 0; idx < fileRefs.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) await yieldToEventLoop();
    const fr = fileRefs[idx];
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

      // 0. Type-aware resolution (bypasses heuristics if TS compiler found the exact target).
      // The id the extractor emits is keyed by the program's absolute path; symbol ids are
      // keyed by repo-relative path. Strip the base rather than making either side guess.
      if (ref.resolvedTargetId) {
        const id = ref.resolvedTargetId.startsWith(`${base}/`)
          ? ref.resolvedTargetId.slice(base.length + 1)
          : ref.resolvedTargetId;
        targetSym = symbolById.get(id) || null;
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

      /**
       * Smallest enclosing execution context. `class` is in the list because a field
       * initialiser or static block executes, and attributing those to the class beats
       * attributing them to the module: measured, 5 edges and 9 fewer synthetic module nodes.
       *
       * `constant` was tried and REMOVED - it changed the counts by exactly 0, and it is
       * wrong anyway. An arrow held in a `const` is already extracted with kind `function`,
       * so the case it was meant to catch was never missing; and for `const x = foo()` the
       * initialiser runs at MODULE scope, so naming `x` - a binding, not an execution
       * context - as the caller would have been a confident wrong answer.
       *
       * Types, interfaces and enums are excluded: nothing in them executes.
       */
      const callerCandidates = fr.symbolsInFile.filter(
        s =>
          s.kind === "function" ||
          s.kind === "method" ||
          s.kind === "component" ||
          s.kind === "class",
      );
      const enclosing = findEnclosingCaller(callerCandidates, ref.line);
      // No enclosing symbol means module scope - which is a real caller, not an absence.
      const caller = enclosing ?? moduleSymbolOf(fr.file);

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
    /**
     * A self-edge (recursion) is a real outgoing call, so it counts in `fanOut` and in
     * `resolvedCalls`, and it is emitted so `cycles()` can see it. It deliberately does NOT
     * count in `fanIn`: fan-in answers "who else depends on this", and it is what `deadCode()`
     * and blast radius read. A recursive function that nothing else calls is still unreferenced,
     * and letting it call itself out of the dead-code list would be the symbol marking its own
     * homework.
     */
    if (source !== target) {
      t.fanIn += Math.min(count, 5); // cap at 5 per distinct caller to prevent massive spam from one file
    }
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
