import ts from "typescript";

/**
 * Where in the source a match landed.
 *
 * Line-regex rules cannot tell `eval(` in running code from `eval(` in a doc comment or inside
 * a string literal, and the difference is the whole finding. Measured across every rule match:
 * **35% on express, 64% on this repository** fire in a context where the rule cannot be true.
 * (Self-analysis is inflated because our own rule table contains these regexes as literals -
 * which is itself a real false positive, just an unrepresentative rate.)
 */
export type SourceContext = "code" | "comment" | "string";

export interface SourceSpan {
  start: number;
  end: number;
  kind: "comment" | "string";
}

/** Extensions the TypeScript scanner can tokenise correctly. */
const TS_FAMILY = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/**
 * How deeply a file could actually be analysed (HLD §8.3).
 *
 * The ladder existed only in the design document: nothing recorded a tier, nothing published
 * coverage by tier, and the promise that `lexical` findings are "marked low-confidence" was
 * not kept anywhere in the code.
 *
 * `ast` is defined but NOT currently produced, and saying so is the point of listing it. Every
 * language with an AST path here is TypeScript-family and goes through the compiler, which
 * lands on `full`; Python's extractor is regex-based, so it is `lexical`. The rung is real in
 * the design and empty in the implementation - a tree-sitter grammar for a non-TS language
 * would fill it. Recorded rather than quietly dropped, so the gap stays visible.
 */
export type AnalysisTier = "full" | "ast" | "lexical" | "skipped";

/**
 * The tier a file's extension permits. `skipped` is decided by the scanner (too large,
 * unreadable, no language), not here.
 */
export function tierForExt(ext: string): Exclude<AnalysisTier, "skipped"> {
  return TS_FAMILY.has(ext) ? "full" : "lexical";
}

/**
 * Comment and string-literal ranges, via the TypeScript **scanner**.
 *
 * A scanner, not a parser, on purpose: this needs token boundaries, not a tree, and it must run
 * over every file on every index. The scanner also tokenises broken or partial source without
 * throwing, which a parse tree does not guarantee.
 *
 * Returns `[]` for languages outside the TS family - Python among them - so callers treat every
 * position as `code` and behaviour is exactly as it was. That is deliberate. A hand-rolled
 * lexer for `#` comments and triple-quoted strings would be wrong at the edges, and a wrong
 * span SUPPRESSES a real finding. Trading false positives for silent false negatives is a bad
 * trade in a tool whose credibility is the product.
 */
export function syntacticSpans(text: string, ext: string): SourceSpan[] {
  if (!TS_FAMILY.has(ext)) return [];
  const spans: SourceSpan[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ext === ".tsx" || ext === ".jsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    switch (token) {
      case ts.SyntaxKind.SingleLineCommentTrivia:
      case ts.SyntaxKind.MultiLineCommentTrivia:
        spans.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), kind: "comment" });
        break;
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        spans.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), kind: "string" });
        break;
      default:
        break;
    }
  }
  return spans;
}

/**
 * Classify an absolute offset. `spans` must come from `syntacticSpans` for the same text.
 *
 * Binary search rather than a scan: this runs once per rule match per file, and the linear
 * version made the whole pass quadratic in files with many string literals.
 */
export function contextAt(spans: SourceSpan[], pos: number): SourceContext {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (pos < s.start) hi = mid - 1;
    else if (pos >= s.end) lo = mid + 1;
    else return s.kind;
  }
  return "code";
}
