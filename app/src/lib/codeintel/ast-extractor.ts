import Parser from "web-tree-sitter";
import { resolve } from "node:path";
import type { LanguageExtractor, ExtractResult, RawSymbol } from "./extractors";

let parser: Parser | null = null;
let tsLanguage: Parser.Language | null = null;
let initAttempted = false;

// WASM lives in <appRoot>/wasm (committed, and traced into the standalone build).
function wasmDir(): string {
  return resolve(process.cwd(), "wasm");
}

export async function initTreeSitter(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;
  try {
    await Parser.init({
      locateFile: (name: string) => resolve(wasmDir(), name),
    });
    const p = new Parser();
    tsLanguage = await Parser.Language.load(resolve(wasmDir(), "tree-sitter-typescript.wasm"));
    parser = p; // only mark ready once a grammar loaded
  } catch {
    // WASM unavailable in this environment → extractors fall back to regex.
    parser = null;
    tsLanguage = null;
  }
}

export const astTsExtractor = (fallback: LanguageExtractor): LanguageExtractor => ({
  language: "TypeScript",
  exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  extract(text: string): ExtractResult {
    if (!parser || !tsLanguage) {
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

    walk(cursor);

    return { symbols, references };
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
