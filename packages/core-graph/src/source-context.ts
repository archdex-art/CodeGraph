import ts from "typescript";
import { contentCache } from "./content-cache";

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
 * Comment and string-literal ranges, via the TypeScript **parser**.
 *
 * **This used a raw `createScanner` loop and that was wrong.** A bare `while (scan())` has no
 * way to `rescanTemplateToken` after a `TemplateHead`, or to `reScanSlashToken` when deciding
 * regex-versus-division, so it desynchronises at the first `${...}` or `/` and mis-tokenises
 * everything after. Measured against the parser over 4,783 sampled positions in this
 * repository: **1,125 (23.5%) were plain code reported as `string`** - `process.exitCode = 1;`
 * among them. That silently SUPPRESSES findings, which is the failure direction this module's
 * own comment claims to avoid.
 *
 * The original measurement that justified context gating was parser-based; only the shipped
 * implementation was not. The two now agree.
 *
 * Returns `[]` for languages outside the TS family - Python among them - so callers treat every
 * position as `code` and behaviour is exactly as it was. That is deliberate. A hand-rolled
 * lexer for `#` comments and triple-quoted strings would be wrong at the edges, and a wrong
 * span SUPPRESSES a real finding. Trading false positives for silent false negatives is a bad
 * trade in a tool whose credibility is the product.
 */
/**
 * Bumped whenever the span rules change. Forgetting to bump serves entries computed by the old
 * logic - which is how the scanner-desync bug would have outlived its own fix.
 */
const SPANS_VERSION = "spans-2-parser";

export function syntacticSpans(text: string, ext: string): SourceSpan[] {
  if (!TS_FAMILY.has(ext)) return [];
  return contentCache.get(text, ext, SPANS_VERSION, () => computeSpans(text, ext));
}

function computeSpans(text: string, ext: string): SourceSpan[] {
  const sf = ts.createSourceFile(
    `f${ext}`,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const spans: SourceSpan[] = [];
  const seenComment = new Set<number>();

  /**
   * Both APIs are needed. TypeScript classifies a comment appearing BEFORE the first newline
   * after a token as that token's TRAILING comment, and `getLeadingCommentRanges` deliberately
   * skips it - so `const a = 1; // note` is invisible to the leading call alone. Caught by the
   * simplest test in this module's suite, which is the one that nearly was not written.
   */
  const addComments = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seenComment.has(r.pos)) continue;
      seenComment.add(r.pos);
      spans.push({ start: r.pos, end: r.end, kind: "comment" });
    }
  };

  const walk = (n: ts.Node): void => {
    addComments(ts.getLeadingCommentRanges(text, n.getFullStart()));
    addComments(ts.getTrailingCommentRanges(text, n.getEnd()));
    if (ts.isTemplateExpression(n)) {
      /**
       * Only the literal chunks are string. `${...}` is CODE, and marking the whole template
       * would suppress every finding inside a substitution - exactly the `${userInput}` spot
       * worth looking at.
       */
      spans.push({ start: n.head.getStart(sf), end: n.head.getEnd(), kind: "string" });
      for (const span of n.templateSpans) {
        spans.push({ start: span.literal.getStart(sf), end: span.literal.getEnd(), kind: "string" });
      }
    } else if (ts.isStringLiteralLike(n)) {
      spans.push({ start: n.getStart(sf), end: n.getEnd(), kind: "string" });
    }
    ts.forEachChild(n, walk);
  };
  // `forEachChild` visits `endOfFileToken` as a child of the source file, so comments after
  // the last statement arrive through the normal walk. An explicit EOF pass was written here
  // and removed once mutation testing showed deleting it changed nothing.
  walk(sf);

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Comment and string ranges for the languages the TypeScript parser cannot read.
 *
 * **Why this exists, given the paragraph above says it should not.** That paragraph is right
 * about JavaScript and wrong about everything else, and the cost of the gap was measured, not
 * argued: with no spans, `detect.ts` treats every position as `code`, so `context` is a no-op
 * outside the TS family. A Python file containing only a docstring that says "an interactive
 * eval() is available" and a string containing "# TODO" produced TWO findings — one of them
 * `Use of eval()` at **severity 5** — where the byte-identical TypeScript produced none.
 * Choosing not to lex did not avoid the risk; it took 100% of it in the other direction.
 *
 * The hazards that motivated the refusal are JS-specific: regex-versus-division, template
 * substitutions, `rescanTemplateToken`. None of them exist in Python, Go, Java, Ruby, C#,
 * Rust, C or PHP, whose comment and string grammars are the boring ones. The TS family keeps
 * the parser; only the languages with a tractable lexical grammar come through here.
 *
 * Deliberately conservative in the direction that matters. Anything it cannot classify stays
 * `code`, so an unrecognised construct fails toward REPORTING a finding rather than silently
 * swallowing one — the trade the original comment asks for, just applied to a case where
 * doing nothing was not neutral.
 */
interface LexRules {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
  /** Longest-first: `"""` must be tried before `"`. */
  quote: readonly string[];
  /** Languages where a backslash escapes the next character inside a string. */
  escape: boolean;
}

const C_LIKE: LexRules = { line: ["//"], block: [["/*", "*/"]], quote: ['"', "'"], escape: true };
const HASH_LIKE = (quotes: readonly string[]): LexRules => ({
  line: ["#"],
  block: [],
  quote: quotes,
  escape: true,
});

const LEX_BY_EXT: Record<string, LexRules> = {
  // Triple quotes first so a docstring is one span, not three empty strings.
  ".py": HASH_LIKE(['"""', "'''", '"', "'"]),
  ".rb": HASH_LIKE(['"', "'"]),
  ".sh": HASH_LIKE(['"', "'"]),
  ".go": C_LIKE,
  ".rs": C_LIKE,
  ".java": C_LIKE,
  ".kt": C_LIKE,
  ".scala": C_LIKE,
  ".swift": C_LIKE,
  ".cs": C_LIKE,
  ".c": C_LIKE,
  ".h": C_LIKE,
  ".cpp": C_LIKE,
  ".hpp": C_LIKE,
  // PHP takes both families; `#` is a line comment there too.
  ".php": { line: ["//", "#"], block: [["/*", "*/"]], quote: ['"', "'"], escape: true },
};

export function lexicalSpans(text: string, ext: string): SourceSpan[] {
  const rules = LEX_BY_EXT[ext];
  if (!rules) return [];
  const spans: SourceSpan[] = [];
  let i = 0;

  while (i < text.length) {
    const lineTok = rules.line.find((t) => text.startsWith(t, i));
    if (lineTok) {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      spans.push({ start: i, end, kind: "comment" });
      i = end;
      continue;
    }

    const block = rules.block.find(([open]) => text.startsWith(open, i));
    if (block) {
      const close = text.indexOf(block[1], i + block[0].length);
      const end = close === -1 ? text.length : close + block[1].length;
      spans.push({ start: i, end, kind: "comment" });
      i = end;
      continue;
    }

    const quote = rules.quote.find((q) => text.startsWith(q, i));
    if (quote) {
      let j = i + quote.length;
      while (j < text.length) {
        if (rules.escape && text[j] === "\\") { j += 2; continue; }
        if (text.startsWith(quote, j)) { j += quote.length; break; }
        // A single-quote string does not survive a newline in any language here, and
        // treating an apostrophe in prose as an unterminated string would swallow the
        // rest of the file. Triple quotes are the exception and do span lines.
        if (text[j] === "\n" && quote.length === 1) break;
        j++;
      }
      spans.push({ start: i, end: Math.min(j, text.length), kind: "string" });
      i = Math.max(j, i + 1);
      continue;
    }

    i++;
  }
  return spans;
}

/**
 * The best spans available for a file: parsed where we can parse, lexed where we cannot,
 * empty only for a language we have no grammar for at all.
 */
export function spansFor(text: string, ext: string): SourceSpan[] {
  return TS_FAMILY.has(ext) ? syntacticSpans(text, ext) : lexicalSpans(text, ext);
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
