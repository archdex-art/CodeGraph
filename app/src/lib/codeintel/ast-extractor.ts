import Parser from "web-tree-sitter";
import { resolve } from "node:path";
import type { LanguageExtractor, ExtractResult, RawSymbol } from "./extractors";

let parser: Parser | null = null;
let tsLanguage: Parser.Language | null = null;
let initAttempted = false;

// web-tree-sitter's WASM linear memory is a singleton for the process
// lifetime (shared by every `Parser` instance) and, per the WASM spec, can
// only grow — never shrink — regardless of how diligently Tree/TreeCursor
// are `.delete()`d (see the `finally` below). Measured directly, in the
// real bundled server (not an isolated script):
// RSS climbed 89MB → 234MB → 312MB → 484MB across just the first 5/10/15
// files of an ordinary repo (expressjs/express) — roughly 26MB/file —
// which blows through Render's 512MB Starter plan and gets the whole
// process OOM-killed. Per-file cost varies too much by content to budget
// with a fixed file count (an earlier fixed-count budget still undershot
// this by ~3x), so check actual RSS before every parse instead: once it
// crosses a safe ceiling, stop feeding tree-sitter for the rest of the
// process's life and use the regex fallback extractor, which needs no WASM
// memory at all. The ceiling has to leave real headroom, not just
// "whatever's left below the container limit": since RSS never comes back
// down once WASM has grown it, everything indexRepo does AFTER the last
// tree-sitter call (dependency/viz/tree/module-graph building, JSON
// serialization for the DB write, SQLite's own write path) has to fit in
// the remainder — verified even a 300MB ceiling, and then a 150MB one,
// still let the same 512MB container OOM once that other work ran on top
// (in one case the job itself finished and reported success before the
// container died moments later from residual growth). Default the budget
// to effectively "don't use it" — proven to run cleanly end-to-end — and
// let deployments with real memory headroom (a bigger plan, self-hosted)
// opt back in via the env var.
const MAX_RSS_BYTES = Number(process.env.CG_TREE_SITTER_MAX_RSS_BYTES) || 0;
let treeSitterDisabledForRss = false;

function rssBudgetExceeded(): boolean {
  if (treeSitterDisabledForRss) return true;
  if (process.memoryUsage().rss >= MAX_RSS_BYTES) {
    treeSitterDisabledForRss = true;
    return true;
  }
  return false;
}

// WASM lives in <appRoot>/wasm (committed, and traced into the standalone build).
function wasmDir(): string {
  return resolve(process.cwd(), "wasm");
}

// web-tree-sitter's Emscripten-generated loader can leave its init promise
// permanently unresolved (neither resolved nor rejected) when the WASM
// binary is missing/unreadable — verified: it throws inside an internal
// `abort()` call that never reaches the promise chain, so a bare `await`
// here hangs the whole indexing job forever instead of hitting the `catch`
// below. Race against a hard timeout so any failure mode — missing file,
// slow/starved compile, or this loader bug — degrades to the regex
// fallback instead of stalling every job that follows.
const INIT_TIMEOUT_MS = Number(process.env.CG_TREE_SITTER_INIT_TIMEOUT_MS) || 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function initTreeSitter(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;
  try {
    await withTimeout(
      Parser.init({ locateFile: (name: string) => resolve(wasmDir(), name) }),
      INIT_TIMEOUT_MS,
      "Tree-sitter WASM init"
    );
    const p = new Parser();
    tsLanguage = await withTimeout(
      Parser.Language.load(resolve(wasmDir(), "tree-sitter-typescript.wasm")),
      INIT_TIMEOUT_MS,
      "Tree-sitter grammar load"
    );
    parser = p; // only mark ready once a grammar loaded
  } catch {
    // WASM unavailable/too slow in this environment → extractors fall back to regex.
    parser = null;
    tsLanguage = null;
  }
}

export const astTsExtractor = (fallback: LanguageExtractor): LanguageExtractor => ({
  language: "TypeScript",
  exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  extract(text: string): ExtractResult {
    if (!parser || !tsLanguage || rssBudgetExceeded()) {
      return fallback.extract(text);
    }
    parser.setLanguage(tsLanguage);
    const tree = parser.parse(text);
    const symbols: RawSymbol[] = [];
    const references = new Map<string, number>();

    // LSP-lite: track EXACT imports so we resolve calls accurately
    // e.g. import { foo as bar } from './baz' -> we know 'bar' maps to 'baz#foo'
    // For now we just collect references to symbols to feed into graph.ts
    
    // Walk AST
    const cursor = tree.walk();
    const walk = (c: Parser.TreeCursor) => {
      const type = c.nodeType;
      
      // Function / Method declarations
      if (type === "function_declaration" || type === "method_definition" || type === "arrow_function") {
        const node = c.currentNode;
        // find name
        const nameNode = node.childForFieldName("name") || (type === "arrow_function" ? getArrowName(node) : null);
        if (nameNode) {
          const isExported = node.parent?.type === "export_statement" || node.parent?.parent?.type === "export_statement";
          const kind = type === "method_definition" ? "method" : "function";
          // Find container (class)
          let container = null;
          let p = node.parent;
          while (p) {
            if (p.type === "class_declaration") {
              container = p.childForFieldName("name")?.text || null;
              break;
            }
            p = p.parent;
          }

          symbols.push({
            name: nameNode.text,
            kind,
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: node.text.split("\n")[0].slice(0, 100),
            doc: getDoc(node),
            exported: isExported,
            container,
          });
        }
      }

      // Class declarations
      if (type === "class_declaration" || type === "interface_declaration") {
        const node = c.currentNode;
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const isExported = node.parent?.type === "export_statement";
          symbols.push({
            name: nameNode.text,
            kind: type === "class_declaration" ? "class" : "interface",
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: node.text.split("\n")[0].slice(0, 100),
            doc: getDoc(node),
            exported: isExported,
            container: null,
          });
        }
      }

      // Call expressions (References)
      if (type === "call_expression") {
        const node = c.currentNode;
        const funcNode = node.childForFieldName("function");
        if (funcNode) {
          // just grab the identifier
          let name = funcNode.text;
          if (funcNode.type === "member_expression") {
            const prop = funcNode.childForFieldName("property");
            if (prop) name = prop.text;
          }
          references.set(name, (references.get(name) || 0) + 1);
        }
      }

      if (c.gotoFirstChild()) {
        do {
          walk(c);
        } while (c.gotoNextSibling());
        c.gotoParent();
      }
    };

    try {
      walk(cursor);
      return { symbols, references };
    } finally {
      // tree-sitter's Tree/TreeCursor are backed by WASM linear memory, which
      // is never garbage-collected by V8 — only freed via explicit .delete().
      // Without this, every parsed file leaks its AST for the lifetime of the
      // process: harmless on a handful of files, fatal (OOM) on a real repo
      // with hundreds of them, since one process indexes every file in a run.
      cursor.delete();
      tree.delete();
    }
  }
});

function getArrowName(node: Parser.SyntaxNode) {
  // const foo = () => {}
  const parent = node.parent;
  if (parent && parent.type === "variable_declarator") {
    return parent.childForFieldName("name");
  }
  return null;
}

function getDoc(node: Parser.SyntaxNode) {
  let prev = node.previousSibling;
  if (node.parent?.type === "export_statement") prev = node.parent.previousSibling;
  if (prev && prev.type === "comment") {
    return prev.text.replace(/^\/\*\*?|\*\/$|^\*\s?|^\/\/\s?/g, "").trim().slice(0, 300);
  }
  return null;
}
