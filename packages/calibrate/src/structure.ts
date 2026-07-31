/**
 * Structural markers from file text (PLAN.md §5.2, corrected).
 *
 * WHY THESE EXIST. The first corpus carried nine markers, all derived from `git log`, and the
 * fit lost to `sort by lines-of-code`. The reference implementation this project cites
 * describes its 21 signals as *"complexity, hidden coupling, missing tests, churn, fragile
 * ownership"* (repowise.dev, retrieved 2026-07-30) — complexity first, tests third. PLAN.md
 * §5.2 had characterised that source as ranking git markers ABOVE static complexity, which it
 * does not. This module adds the class that was missing.
 *
 * TEXT-BASED, NOT AST-BASED, and the limitation is real. A brace-and-keyword scan miscounts
 * inside strings, comments, and regex literals, and it cannot tell a nested function from a
 * nested block. It is used anyway because the alternative — importing the analyser — is
 * forbidden by the layering rule for a deliberate reason: a calibration run must not be able to
 * reach the scorer whose weights it is fitting. A rough complexity proxy that cannot see the
 * scorer is worth more here than an exact one that can.
 *
 * These are FEATURES FOR A FIT, not product metrics. Nothing here feeds the Health Score.
 */

export interface StructuralMetrics {
  /** Branch points + 1. The standard cyclomatic proxy. */
  cyclomatic: number;
  /** Deepest brace/indent nesting reached. */
  maxNesting: number;
  /** Function/method declarations found. */
  functions: number;
  /** Comment lines / total lines, 0..1. */
  commentRatio: number;
  /** Longest run of consecutive non-blank lines — a crude "longest function" proxy. */
  longestBlock: number;
}

/** Tokens that introduce a branch in C-family and Python syntax alike. */
const BRANCH_RE =
  /\b(if|else\s+if|elif|for|while|case|catch|except|finally)\b|\?\?|\?\.|&&|\|\||\?[^.:]/g;

const FUNCTION_RE =
  /\b(function\s+\w+|def\s+\w+|=>\s*\{|\w+\s*\([^)]*\)\s*\{)|^\s*(async\s+)?\w+\s*\([^)]*\)\s*[:{]/gm;

const LINE_COMMENT_RE = /^\s*(\/\/|#|\*|\/\*)/;

/**
 * Strip string and comment content before scanning.
 *
 * Not a parser, and not pretending to be. It removes the three constructs that most distort a
 * keyword count — block comments, line comments, and quoted strings — so a file containing the
 * word "if" in prose does not read as branchy. Template literals with embedded expressions are
 * knowingly imperfect here.
 */
function stripNoise(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
}

export function structuralMetrics(text: string, isPython: boolean): StructuralMetrics {
  const lines = text.split("\n");
  const code = stripNoise(text);

  const cyclomatic = 1 + (code.match(BRANCH_RE)?.length ?? 0);
  const functions = code.match(FUNCTION_RE)?.length ?? 0;

  let commentLines = 0;
  for (const l of lines) if (LINE_COMMENT_RE.test(l)) commentLines++;

  // Nesting: braces for C-family, leading indentation for Python. Two different shapes of the
  // same question, and using the wrong one gives a flat 0 for a deeply nested file.
  let maxNesting = 0;
  if (isPython) {
    for (const l of lines) {
      if (!l.trim() || LINE_COMMENT_RE.test(l)) continue;
      const indent = (l.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length;
      maxNesting = Math.max(maxNesting, Math.floor(indent / 4));
    }
  } else {
    let depth = 0;
    for (const ch of code) {
      if (ch === "{") {
        depth++;
        maxNesting = Math.max(maxNesting, depth);
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }

  let longestBlock = 0;
  let run = 0;
  for (const l of lines) {
    if (l.trim()) {
      run++;
      longestBlock = Math.max(longestBlock, run);
    } else {
      run = 0;
    }
  }

  return {
    cyclomatic,
    maxNesting,
    functions,
    commentRatio: lines.length === 0 ? 0 : commentLines / lines.length,
    longestBlock,
  };
}
