import type { FileEdit, Fixer } from "../types";


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

/**
 * REMOVED, and not coming back in this shape: `remove-debug-output` and `remove-todo-marker`.
 *
 * Both were deleted after a real run against this repository produced 30 edits across 14
 * files — 13 TODO markers, 8 debug lines, 9 empty catches — and the FIRST edit deleted
 *
 *     print(f"check_boundaries: OK — {scanned} source files, 0 violations")
 *
 * from `scripts/check_boundaries.py`. That line is the script's entire output. The fixer's
 * whole safety argument was "a standalone `print()`/`console.log` has no production
 * behaviour", and for a CLI script the print IS the production behaviour — a property no AST
 * guard can recover, because the difference between "debug residue" and "the program's
 * output" is intent, not syntax.
 *
 * `remove-todo-marker` was never unsafe; it was worthless. A PR whose diff deletes TODO
 * comments and print statements is noise, and a reviewer who rejects it has learned to
 * ignore the next one — which is the expensive failure, since the point of the executor is a
 * patch a human merges.
 *
 * The bar in `types.ts` says a fixer ships only if its change cannot alter behaviour AND
 * removes an issue the scorer counts. These two each failed a different half of it.
 */

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
        after,
        fixer: "annotate-empty-catch",
        reason: "Documented an empty catch block's intent instead of silently swallowing the error (no behavior change).",
      });
    }
    return { lines: out, edits };
  },
};

export const FIXERS: Fixer[] = [emptyCatchFixer];

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
