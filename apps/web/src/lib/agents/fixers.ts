import type { FileEdit } from "./executor-types";

export interface FixerInput {
  rel: string; // posix repo-relative path
  ext: string;
  lines: string[];
}

export interface FixerOutput {
  lines: string[]; // possibly mutated
  edits: FileEdit[];
}

/**
 * A Fixer is a safe, deterministic codemod over a single file's lines.
 * SAFETY BAR: only transformations that (a) cannot change program behavior in the
 * common case and (b) remove an issue the scorer actually counts. This keeps the
 * executor's "verified" claim honest — re-indexing must show the score improve.
 */
export interface Fixer {
  id: string;
  label: string;
  /**
   * The rule ids this fixer can fix — "THE binding v1 lacks entirely" (LLD §7.1),
   * review item C1.
   *
   * Without it there is no relation between a finding and a fixer, and the consequence was
   * concrete rather than theoretical: `POST /api/repos/:id/fix` ran ALL THREE fixers over
   * EVERY file, so clicking a P0 "untrusted input reaches eval()" finding produced a diff
   * deleting `console.log` in 27 unrelated files. The ranked plan and the executor were two
   * disconnected systems that the UI implied were one.
   *
   * Ids are the `legacy/<slugged-title>` form that migration 003 assigns, because that is
   * what findings in the database actually carry today. P5's rule registry replaces them
   * with real ids, and this field is the seam that makes that a rename rather than a
   * redesign.
   */
  handles: readonly string[];
  apply(input: FixerInput): FixerOutput;
}

/**
 * Slug a finding title into the rule id migration 003 assigns.
 *
 * Duplicated deliberately from `persistence`'s `legacyRuleId` rather than exported from it:
 * that function is a fixed property of a released migration and must never change, while
 * this one follows whatever the current findings carry. Coupling them would make a
 * migration's frozen behaviour a live dependency of the fixer registry.
 */
export function legacyRuleIdFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `legacy/${slug || "unknown"}`;
}

import { deletableDebugLines } from "./ast-guards";

const JS_EXTS: Record<string, true> = { ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true };

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

// Python compound-statement headers that require a non-empty indented suite.
// Anchored to the keyword so this never misfires on a dict/type-annotation
// line that merely ends in `:` (e.g. `"key":` or `x: int`).
const PY_BLOCK_OPENER_RE = /^(async\s+)?(if|elif|else|for|while|try|except|finally|with|def|class)\b.*:\s*(#.*)?$/;

/**
 * Python requires at least one statement inside every `...:` suite. If every
 * statement in a block is a standalone debug print (the only thing this fixer
 * ever deletes), deleting them all leaves an empty suite -> SyntaxError. Since
 * the diff builder is deletion-only (no way to represent an inserted `pass`),
 * the safe fix is conservative: never let a block's candidate-deletions empty
 * it out entirely — keep its last statement instead.
 */
function protectPythonBlockBodies(lines: string[], candidateDelete: Set<number>): void {
  for (let i = 0; i < lines.length; i++) {
    const opener = lines[i];
    if (!PY_BLOCK_OPENER_RE.test(opener.trim())) continue;
    const openIndent = indentOf(opener);
    let j = i + 1;
    let lastNonBlank = -1;
    let allDeletable = true;
    while (j < lines.length) {
      if (lines[j].trim() === "") { j++; continue; }
      if (indentOf(lines[j]) <= openIndent) break;
      lastNonBlank = j;
      if (!candidateDelete.has(j)) allDeletable = false;
      j++;
    }
    if (lastNonBlank >= 0 && allDeletable) candidateDelete.delete(lastNonBlank);
  }
}

/**
 * JS/TS has the same hazard Python does, in a shape the indentation check above
 * can't see: a brace-less block body.
 *
 *     if (!authorized)
 *       console.log("denied");
 *     grantAccess();
 *
 * Deleting line 2 promotes `grantAccess()` into the `if` — the file still
 * PARSES, so no syntax check catches it, and the program now does the opposite
 * of what it did. Same for `else`, `for`, `while`, `do`, and arrow bodies
 * (`arr.forEach(x =>\n  console.log(x)\n)`), which becomes a syntax error.
 *
 * Without a parser we can't know for certain whether a line is a block body, so
 * we are deliberately conservative: a deletion is refused whenever the
 * preceding effective line ends in a token that can open a brace-less body
 * (`)`, `=>`, `else`, `do`). That over-protects in semicolon-less code — e.g.
 * `doSomething()` on the line above — costing us a few legitimate deletions.
 * Skipping a valid fix is a non-event; corrupting control flow in someone's
 * repo is not, so the trade is one-sided.
 *
 * "Preceding effective line" skips blanks, comment-only lines, and lines that
 * are themselves being deleted — otherwise a run of consecutive semicolon-less
 * `console.log(...)` lines would protect each other for no reason.
 */


// Remove standalone debug output / debugger statements (leftover from development).
// Matches ONLY whole-line statements so we never split an expression, and never
// empties a Python block's body or a JS brace-less block body (either of which
// would change behavior or produce invalid syntax).
const debugFixer: Fixer = {
  id: "remove-debug-output",
  label: "Remove leftover debug output",
  // Both rules that emit a debug-output finding in `analysis`'s RULES table.
  handles: ["legacy/leftover-debug-output", "legacy/debugger-statement"],
  apply({ rel, ext, lines }) {
    const isJs = JS_EXTS[ext];
    const isPy = ext === ".py";
    const candidateDelete = new Set<number>();

    if (isJs) {
      // AST, not a line scan (review B1, LLD §7.1). The regex version deleted a
      // `console.log(...)` line INSIDE A TEMPLATE LITERAL — silently rewriting a user-visible
      // help string while reporting "no production behavior" — and the result still parsed, so
      // neither its own guard nor verification gate 1 caught it. See ast-guards.ts.
      const { deletable } = deletableDebugLines(lines.join("\n"), rel);
      for (const line of deletable) candidateDelete.add(line);
    } else if (isPy) {
      // Python keeps the line-based path: there is no Python parser in this process, and
      // `protectPythonBlockBodies` below is indentation-aware, which is the property that
      // matters for a language where indentation IS the block structure.
      for (let i = 0; i < lines.length; i++) {
        if (/^print\(.*\)\s*$/.test(lines[i].trim())) candidateDelete.add(i);
      }
      protectPythonBlockBodies(lines, candidateDelete);
    }

    const edits: FileEdit[] = [];
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (candidateDelete.has(i)) {
        edits.push({
          file: rel,
          line: i + 1,
          before: lines[i].trim().slice(0, 120),
          after: null,
          fixer: "remove-debug-output",
          reason: "Removed leftover debug statement (no production behavior).",
        });
        continue; // drop the line
      }
      out.push(lines[i]);
    }
    return { lines: out, edits };
  },
};

// Remove standalone TODO/FIXME/HACK/XXX marker comments (leftover from
// development). Only matches whole-line, comment-only statements (line starts
// with `//` or `#`) — never a code line that happens to mention one of these
// words inside a string literal, which could be real, load-bearing text.
// Comments are stripped before execution in every supported language, so
// deleting one can never change runtime behavior.
const todoFixer: Fixer = {
  id: "remove-todo-marker",
  label: "Remove stale TODO/FIXME marker",
  handles: ["legacy/todo-fixme-marker"],
  apply({ rel, lines }) {
    const markerRe = /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/;
    const commentLineRe = /^(\/\/|#)/;
    const candidateDelete = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (commentLineRe.test(t) && markerRe.test(t)) candidateDelete.add(i);
    }

    const edits: FileEdit[] = [];
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (candidateDelete.has(i)) {
        edits.push({
          file: rel,
          line: i + 1,
          before: lines[i].trim().slice(0, 120),
          after: null,
          fixer: "remove-todo-marker",
          reason: "Removed a stale TODO/FIXME/HACK/XXX comment (comment-only line; no behavior change).",
        });
        continue;
      }
      out.push(lines[i]);
    }
    return { lines: out, edits };
  },
};

// Document (never silently drop) an empty catch block. A `catch (e) {}` swallows
// errors with zero trace of intent — the standard, safe remediation is to make
// the intent explicit, not to delete error handling (which could change control
// flow if anything is later added to the block). A block comment has zero
// runtime effect, so this can never change program behavior; it only stops
// matching the indexer's "empty" regex because the braces are no longer empty.
const JS_ONLY: Record<string, true> = { ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true };
const EMPTY_CATCH_RE = /catch\s*\([^)]*\)\s*\{\s*\}/;
const emptyCatchFixer: Fixer = {
  id: "annotate-empty-catch",
  label: "Document empty catch blocks",
  handles: ["legacy/empty-catch-block"],
  apply({ rel, ext, lines }) {
    if (!JS_ONLY[ext]) return { lines, edits: [] };
    const edits: FileEdit[] = [];
    const out = lines.slice();
    for (let i = 0; i < out.length; i++) {
      if (!EMPTY_CATCH_RE.test(out[i])) continue;
      const before = out[i];
      const after = before.replace(/\{\s*\}/, "{ /* intentionally ignored */ }");
      out[i] = after;
      edits.push({
        file: rel,
        line: i + 1,
        before: before.trim().slice(0, 120),
        // `after` is the AUTHORITATIVE replacement line the executor writes to
        // disk and emits in the diff — it MUST be the full, untrimmed content.
        // (debug/todo fixers use after=null, so this is the only replacement.)
        after,
        fixer: "annotate-empty-catch",
        reason: "Documented an empty catch block's intent instead of silently swallowing the error (no behavior change).",
      });
    }
    return { lines: out, edits };
  },
};

export const FIXERS: Fixer[] = [debugFixer, todoFixer, emptyCatchFixer];

/**
 * The fixers that claim a given rule. Empty means the finding is not auto-fixable.
 *
 * Returning a list rather than one fixer keeps the door open for two providers claiming a
 * rule at different safety levels (LLD §7.1's `safety` field), without pretending to choose
 * between them here.
 */
export function fixersForRule(ruleId: string): Fixer[] {
  return FIXERS.filter((f) => f.handles.includes(ruleId));
}

export function fixerById(id: string): Fixer | null {
  return FIXERS.find((f) => f.id === id) ?? null;
}
