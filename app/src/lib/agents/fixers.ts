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
  apply(input: FixerInput): FixerOutput;
}

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

// Remove standalone debug output / debugger statements (leftover from development).
// Matches ONLY whole-line statements so we never split an expression, and never
// empties a Python block's body (which would produce invalid syntax).
const debugFixer: Fixer = {
  id: "remove-debug-output",
  label: "Remove leftover debug output",
  apply({ rel, ext, lines }) {
    const isJs = JS_EXTS[ext];
    const isPy = ext === ".py";
    const candidateDelete = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const jsDebug = isJs && (/^console\.(log|debug|info)\(.*\)\s*;?\s*$/.test(t) || /^debugger\s*;?\s*$/.test(t));
      const pyDebug = isPy && /^print\(.*\)\s*$/.test(t);
      if (jsDebug || pyDebug) candidateDelete.add(i);
    }
    if (isPy) protectPythonBlockBodies(lines, candidateDelete);

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

export const FIXERS: Fixer[] = [debugFixer];

export function fixerById(id: string): Fixer | null {
  return FIXERS.find((f) => f.id === id) ?? null;
}
