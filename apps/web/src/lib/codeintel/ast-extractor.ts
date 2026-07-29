import ts from "typescript";
import type { LanguageExtractor, ExtractResult, RawSymbol, RawReference, RawImport, ExtractContext } from "./extractors";

export interface RawSymbolExtended extends RawSymbol {
  complexity?: number;
}

export function initTreeSitter(): Promise<void> {
  return Promise.resolve();
}

/**
 * Extract the signature head of a declaration: everything up to the body-opening
 * `{`, ignoring `{` that appear inside generic type parameters or parameter type
 * annotations. A naive `.split(/[\n{]/)` truncates `foo<T extends { a: 1 }>()` at
 * the first brace, corrupting the stored signature. We track angle/paren depth and
 * stop at the first brace at depth 0 (or the first newline outside any bracket).
 */
function signatureHead(src: string): string {
  let angle = 0, paren = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "<") angle++;
    else if (c === ">") { if (angle > 0) angle--; }
    else if (c === "(") paren++;
    else if (c === ")") { if (paren > 0) paren--; }
    else if (c === "{" && angle === 0 && paren === 0) return src.slice(0, i).trim();
    else if (c === "\n" && angle === 0 && paren === 0) return src.slice(0, i).trim();
  }
  return src.trim();
}

export const astTsExtractor = (fallback: LanguageExtractor): LanguageExtractor => ({
  language: "TypeScript",
  exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  extract(ctx: ExtractContext): ExtractResult {
    const sourceFile = ctx.program ? ctx.program.getSourceFile(ctx.relPath) : ts.createSourceFile(ctx.relPath, ctx.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const checker = ctx.program ? ctx.program.getTypeChecker() : null;
    
    const symbols: RawSymbolExtended[] = [];
    const references: RawReference[] = [];
    const imports: RawImport[] = [];
    
    const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    let currentContainer: string | null = null;

    function getDoc(node: ts.Node): string | null {
      const ranges = ts.getLeadingCommentRanges(ctx.text, node.pos);
      if (!ranges || ranges.length === 0) return null;
      const last = ranges[ranges.length - 1];
      const comment = ctx.text.slice(last.pos, last.end).trim();
      return comment.replace(/^\/\*\*?|\*\/$|^\*\s?|^\/\/\s?/gm, "").trim().slice(0, 300);
    }

    function isExported(node: ts.Node): boolean {
      return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
    }

    function computeComplexity(node: ts.Node): number {
      let complexity = 1;
      function count(n: ts.Node) {
        if (
          ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) ||
          ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) ||
          ts.isCatchClause(n) || ts.isCaseClause(n) || ts.isConditionalExpression(n)
        ) {
          complexity++;
        } else if (ts.isBinaryExpression(n)) {
          if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            complexity++;
          }
        }
        ts.forEachChild(n, count);
      }
      ts.forEachChild(node, count);
      return complexity;
    }

    function visit(node: ts.Node) {
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        const name = node.name?.text;
        if (name) {
          symbols.push({
            name,
            kind: ts.isClassDeclaration(node) ? "class" : "interface",
            line: lineOf(node),
            endLine: endLineOf(node),
            signature: signatureHead(ctx.text.slice(node.getStart(sourceFile), node.getStart(sourceFile) + 300)),
            doc: getDoc(node),
            exported: isExported(node),
            container: null,
          });
          const prevContainer = currentContainer;
          currentContainer = name;
          ts.forEachChild(node, visit);
          currentContainer = prevContainer;
          return;
        }
      } else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
        let name: string | null = null;
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
          name = node.name && ts.isIdentifier(node.name) ? node.name.text : null;
        } else if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          name = node.parent.name.text;
        }
        
        if (name) {
          const kind = ts.isMethodDeclaration(node) ? "method" : /^[A-Z]/.test(name) && ctx.text.includes("react") ? "component" : "function";
          symbols.push({
            name,
            kind,
            line: lineOf(node),
            endLine: endLineOf(node),
            signature: signatureHead(ctx.text.slice(node.getStart(sourceFile), node.getStart(sourceFile) + 300)),
            doc: getDoc(node),
            exported: isExported(ts.isArrowFunction(node) ? node.parent.parent : node),
            container: ts.isMethodDeclaration(node) ? currentContainer : null,
            complexity: computeComplexity(node),
          });
        }
      } else if (ts.isCallExpression(node)) {
        const expr = node.expression;
        let name = "";
        let refNode: ts.Node = expr;
        if (ts.isIdentifier(expr)) {
          name = expr.text;
        } else if (ts.isPropertyAccessExpression(expr)) {
          name = expr.name.text;
          refNode = expr.name;
        }
        if (name) {
          let resolvedTargetId: string | undefined;
          if (checker) {
            const sym = checker.getSymbolAtLocation(refNode);
            if (sym && sym.declarations && sym.declarations.length > 0) {
              const decl = sym.declarations[0];
              const targetFile = decl.getSourceFile();
              const targetLine = targetFile.getLineAndCharacterOfPosition(decl.getStart(targetFile)).line + 1;
              resolvedTargetId = `${targetFile.fileName}#${sym.name}@${targetLine}`;
            }
          }
          references.push({ name, line: lineOf(refNode), resolvedTargetId });
        }
      } else if (ts.isImportDeclaration(node)) {
        const modulePath = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
        if (modulePath && node.importClause) {
          if (node.importClause.name) {
            imports.push({ localName: node.importClause.name.text, importedName: "default", modulePath });
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const elem of node.importClause.namedBindings.elements) {
                imports.push({
                  localName: elem.name.text,
                  importedName: elem.propertyName ? elem.propertyName.text : elem.name.text,
                  modulePath,
                });
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              imports.push({ localName: node.importClause.namedBindings.name.text, importedName: "*", modulePath });
            }
          }
        }
      }
      
      ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);
    
    return { symbols, references, imports };
  }
});