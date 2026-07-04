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

// Remove standalone debug output / debugger statements (leftover from development).
// Matches ONLY whole-line statements so we never split an expression.
const debugFixer: Fixer = {
  id: "remove-debug-output",
  label: "Remove leftover debug output",
  apply({ rel, ext, lines }) {
    const edits: FileEdit[] = [];
    const out: string[] = [];
    const isJs = JS_EXTS[ext];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      const jsDebug = isJs && (/^console\.(log|debug|info)\(.*\)\s*;?\s*$/.test(t) || /^debugger\s*;?\s*$/.test(t));
      const pyDebug = ext === ".py" && /^print\(.*\)\s*$/.test(t);
      if (jsDebug || pyDebug) {
        edits.push({
          file: rel,
          line: i + 1,
          before: t.slice(0, 120),
          after: null,
          fixer: "remove-debug-output",
          reason: "Removed leftover debug statement (no production behavior).",
        });
        continue; // drop the line
      }
      out.push(line);
    }
    return { lines: out, edits };
  },
};

export const FIXERS: Fixer[] = [debugFixer];

export function fixerById(id: string): Fixer | null {
  return FIXERS.find((f) => f.id === id) ?? null;
}
