import ts from "typescript";
import type { LanguageExtractor, ExtractResult, RawSymbol, RawReference, RawImport, ExtractContext } from "./contracts";

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
    // `getSourceFile` returns undefined when the program does not contain this
    // path — a real case, not a defensive flourish: the program is built from a
    // tsconfig's file list, so a path that does not normalise identically, or a
    // file outside the program's roots, simply is not there. Before the §13.2
    // move `ctx.program` was typed `any`, which hid that entirely.
    //
    // What it actually did, measured rather than assumed: NOT a crash.
    // `ts.forEachChild(undefined, …)` returns without visiting anything and
    // without throwing, so the extractor produced an EMPTY result and reported
    // success. That is the worse failure of the two — a file silently
    // contributes no symbols and no edges, and nothing anywhere says so. It is
    // also a candidate contributor to the call-resolution sparsity measured on
    // express (11 resolved edges across 123 symbols, REVIEW_2026-07-29), since a
    // file whose symbols never enter the graph cannot be a call target.
    //
    // Falling back to a standalone parse is not a new code path — it is the exact
    // one already taken when no program was supplied at all. The only thing lost
    // is type-aware call resolution, which was never going to work for a file the
    // program does not know about.
    const standalone = (): ts.SourceFile =>
      ts.createSourceFile(ctx.relPath, ctx.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const fromProgram = ctx.program?.getSourceFile(ctx.programPath ?? ctx.relPath);
    const sourceFile: ts.SourceFile = fromProgram ?? standalone();
    // Only keep the checker when it can actually answer questions about THIS file.
    const checker = ctx.program && fromProgram ? ctx.program.getTypeChecker() : null;
    
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

    /**
     * Record a reference to `name` at `refNode`, resolving it through the type checker when
     * one is available. Every reference site - direct call, callback argument, JSX tag - goes
     * through here, so they cannot drift apart in how they resolve.
     */
    function pushRef(name: string, refNode: ts.Node): void {
      let resolvedTargetId: string | undefined;
      if (checker) {
        let sym = checker.getSymbolAtLocation(refNode);
        /**
         * Follow the import alias to the real declaration.
         *
         * For `import { target } from "./a"; target();` the symbol at the reference is an
         * ALIAS whose sole declaration is the import specifier - in the REFERENCING file, on
         * the import line. Without this hop the id came out as `b.ts#target@1`, naming a
         * symbol that exists in no file's table, so the lookup missed and resolution fell
         * through to name-based heuristics in silence.
         */
        if (sym && sym.flags & ts.SymbolFlags.Alias) {
          const aliased = checker.getAliasedSymbol(sym);
          if (aliased.declarations?.length) sym = aliased;
        }
        if (sym && sym.declarations && sym.declarations.length > 0) {
          const decl = sym.declarations[0];
          const targetFile = decl.getSourceFile();
          const targetLine =
            targetFile.getLineAndCharacterOfPosition(decl.getStart(targetFile)).line + 1;
          resolvedTargetId = `${targetFile.fileName}#${sym.name}@${targetLine}`;
        }
      }
      references.push({ name, line: lineOf(refNode), resolvedTargetId });
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
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        /**
         * CommonJS exports: `exports.foo = …` and `module.exports.foo = …`.
         *
         * Every branch above matches an ES declaration, so a CommonJS module contributed
         * almost no symbols — and a call to one could not resolve, because there was nothing
         * to resolve TO. Measured on `expressjs/express@a371447`, CommonJS throughout: 123
         * symbols across 159 files and **11 resolved call edges**, with `deadCode()` calling
         * 110 of 123 symbols unreferenced. That is not a sparse codebase; it is an extractor
         * that could not see it.
         *
         * Matched on the AST rather than by regex, so `exports.foo` inside a string or a
         * comment is not a definition, and the assigned expression's real kind is available.
         */
        const lhs = node.left;
        if (ts.isPropertyAccessExpression(lhs) && ts.isIdentifier(lhs.name)) {
          const base = lhs.expression;
          const isExportsBase =
            (ts.isIdentifier(base) && base.text === "exports") ||
            (ts.isPropertyAccessExpression(base) &&
              ts.isIdentifier(base.expression) &&
              base.expression.text === "module" &&
              base.name.text === "exports");
          if (isExportsBase) {
            const rhs = node.right;
            const isCallable =
              ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs) || ts.isClassExpression(rhs);
            symbols.push({
              name: lhs.name.text,
              // A class expression is a class; a function or arrow is a function; anything
              // else assigned to an export is a value, not something calls resolve to.
              kind: ts.isClassExpression(rhs) ? "class" : isCallable ? "function" : "constant",
              line: lineOf(node),
              endLine: endLineOf(node),
              signature: signatureHead(
                ctx.text.slice(node.getStart(sourceFile), node.getStart(sourceFile) + 300),
              ),
              doc: getDoc(node),
              // The left-hand side IS the export. No modifier to inspect.
              exported: true,
              container: null,
              ...(isCallable ? { complexity: computeComplexity(rhs) } : {}),
            });
          }
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
        if (name) pushRef(name, refNode);
        /**
         * A function passed as an ARGUMENT is used, not merely mentioned: `rows.map(parseRow)`
         * means `parseRow` runs. Without this the callee got an edge and the callback got
         * nothing, so a function only ever passed to `map`/`then`/`onClick` looked unreferenced.
         *
         * Gated on the checker deliberately: only emit when the compiler confirms the argument
         * resolves to a function or an arrow, otherwise every string, number and identifier
         * argument becomes a speculative edge. Measured on this repository: 41 such arguments,
         * against 6,836 direct calls.
         */
        if (checker) {
          for (const arg of node.arguments) {
            if (!ts.isIdentifier(arg)) continue;
            const d = checker.getSymbolAtLocation(arg)?.declarations?.[0];
            const callable =
              d &&
              (ts.isFunctionDeclaration(d) ||
                ts.isMethodDeclaration(d) ||
                (ts.isVariableDeclaration(d) &&
                  !!d.initializer &&
                  (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))));
            if (callable) pushRef(arg.text, arg);
          }
        }
      } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        /**
         * Rendering IS invoking: React calls the component function. Before this, all 41
         * components in this repository had zero inbound edges - `<AgentSwarm />` is a
         * `JsxSelfClosingElement`, never a `CallExpression`, so nothing referenced them and
         * every component sat in the graph as an isolated node.
         *
         * The uppercase test is the JSX language rule, not a heuristic: a lowercase tag is an
         * intrinsic element (`div`), an uppercase one resolves to a value in scope.
         */
        const tag = node.tagName;
        if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) pushRef(tag.text, tag);
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