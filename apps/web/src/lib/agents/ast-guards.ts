import ts from "typescript";

/**
 * AST facts about a JS/TS file that a line-based fixer cannot know (review B1, LLD §7.1).
 *
 * B1's structural cure. The shipped guard is a BACKWARD LINE SCAN with regexes: for each line
 * it wants to delete, it walks up to the previous non-blank line and tests whether that line
 * *looks like* a brace-less block opener. LLD §7.1 calls that a patch, and it is — it reasons
 * about text near the edit instead of about the program.
 *
 * Two failures were reproduced against it before this file existed, on the real fixer:
 *
 *   1. A `console.log(...)` line INSIDE A TEMPLATE LITERAL was deleted. Given
 *        const helpText = `
 *          Usage: run --verbose
 *          console.log("hello");
 *        `;
 *      it removed the third line, silently rewriting a user-visible help string while
 *      reporting "no production behavior". The result still parses, so neither the regex guard
 *      nor verification gate 1's bracket-balance check catches it — the file is valid, the
 *      DATA is wrong. This is the worst shape of fixer bug: invisible to every downstream
 *      check.
 *   2. A labelled statement (`outer:` followed by an indented debug call) had its body
 *      removed, moving the label onto the next statement.
 *
 * The AST knows both: the first line is inside a `NoSubstitutionTemplateLiteral` and is not a
 * statement at all, and the second is the `statement` of a `LabeledStatement`.
 *
 * WHAT THIS IS NOT. It does not make the fixer emit range-based `TextEdit`s end to end — the
 * codemods are still line-based and P5's `lang-typescript` at `full` tier is what replaces
 * them. What it does is give the existing fixers a truthful answer to "is this line a
 * standalone statement I may delete?", which is the question they were answering with a
 * regex.
 */

const JS_LIKE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function isJsLike(ext: string): boolean {
  return JS_LIKE.has(ext);
}

export interface DeletableLines {
  /** 0-based line indexes holding a statement that may be deleted outright. */
  readonly deletable: ReadonlySet<number>;
  /** True when the file could not be parsed, in which case NOTHING is deletable. */
  readonly parseFailed: boolean;
}

/**
 * Which 0-based lines hold a debug statement that is safe to delete.
 *
 * Safe means all of:
 *   · it is a real statement node, not text inside a string, template, or comment;
 *   · it is the whole statement — a `console.log` inside a larger expression is untouched;
 *   · removing it does not empty a construct that requires a body.
 *
 * On a parse failure the answer is "nothing", not "fall back to regex". A file this cannot
 * parse is a file whose structure is unknown, and guessing there is what produced B1.
 */
export function deletableDebugLines(text: string, fileName: string): DeletableLines {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  // `parseDiagnostics` is internal but is the only way to know the parse was clean; TS happily
  // returns a partial tree for broken input, and editing from a partial tree is how a fixer
  // corrupts a file it did not understand.
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    return { deletable: new Set(), parseFailed: true };
  }

  const deletable = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && isDebugCall(node.expression)) {
      if (isSafeToRemove(node)) deletable.add(lineOf(source, node));
    } else if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      if (isSafeToRemove(node)) deletable.add(lineOf(source, node));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return { deletable, parseFailed: false };
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line;
}

/** `console.log|debug|info(...)` as the entire expression, not nested in one. */
function isDebugCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return (
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "console" &&
    ["log", "debug", "info"].includes(callee.name.text)
  );
}

/**
 * Whether removing this statement leaves a valid, behaviour-preserving program.
 *
 * The parent tells us. A statement inside a `Block` has siblings or leaves an empty block,
 * both fine. A statement that IS the body of a control-flow construct cannot be removed
 * without either changing what the construct governs or leaving it bodyless.
 */
function isSafeToRemove(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // Inside a block or at the top level: siblings absorb the removal.
  if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent)) return true;

  // A case/default clause's statement list behaves like a block here.
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return true;

  // Everything else means this statement IS somebody's body. Enumerated rather than
  // defaulted-true so a construct nobody thought about is refused, not silently allowed.
  if (
    ts.isIfStatement(parent) ||
    ts.isForStatement(parent) ||
    ts.isForInStatement(parent) ||
    ts.isForOfStatement(parent) ||
    ts.isWhileStatement(parent) ||
    ts.isDoStatement(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isWithStatement(parent) ||
    ts.isArrowFunction(parent)
  ) {
    return false;
  }

  // Unrecognised parent: refuse. The cost of a missed fix is a finding that stays open; the
  // cost of a wrong one is a corrupted file.
  return false;
}
