import { describe, expect, it } from "vitest";
import { FIXERS, fixersForRule, legacyRuleIdFor } from "@codegraph/remediate-engine";

/**
 * The finding→fixer binding (review C1, LLD §7.1's `handles`).
 *
 * This is the relation whose absence produced the bug: with no binding,
 * `POST /api/repos/:id/fix` ran all three fixers over every file, so clicking a P0
 * "untrusted input reaches eval()" finding returned a diff deleting `console.log` in 27
 * unrelated files. A declared binding is only worth something if it matches the rules the
 * analyser actually emits, which is what these tests check.
 */

/**
 * Titles the analyser's RULES table emits for the auto-fixable classes
 * (`packages/analysis/src/indexer.ts`). Listed here rather than imported because the
 * binding must be pinned against the WORDS in that table — if a title is reworded, its
 * rule id changes and a fixer silently orphans. That is the failure this catches.
 */
const EMITTED_FIXABLE_TITLES = [
  "Leftover debug output",
  "debugger statement",
  "Empty catch block",
  "TODO/FIXME marker",
] as const;

describe("fixer → rule binding", () => {
  it("declares no handles for rules the analyser never emits", () => {
    // A dead handle is worse than a missing one: it reads as coverage and delivers none.
    const emitted = new Set(EMITTED_FIXABLE_TITLES.map(legacyRuleIdFor));
    const dead = FIXERS.flatMap((f) =>
      f.handles.filter((h) => !emitted.has(h)).map((h) => `${f.id} -> ${h}`)
    );
    expect(dead).toEqual([]);
  });

  it("has a fixer for every auto-fixable rule the analyser emits", () => {
    const unhandled = EMITTED_FIXABLE_TITLES.map(legacyRuleIdFor).filter(
      (id) => fixersForRule(id).length === 0
    );
    expect(unhandled).toEqual([]);
  });

  it("returns nothing for a rule no fixer claims", () => {
    // The case that motivates the whole binding: a security finding must not resolve to the
    // debug-output codemod.
    expect(fixersForRule("legacy/use-of-eval")).toEqual([]);
    expect(fixersForRule("legacy/possible-hardcoded-secret")).toEqual([]);
  });

  it("resolves each fixable rule to exactly the fixer that claims it", () => {
    expect(fixersForRule("legacy/leftover-debug-output").map((f) => f.id)).toEqual([
      "remove-debug-output",
    ]);
    expect(fixersForRule("legacy/debugger-statement").map((f) => f.id)).toEqual([
      "remove-debug-output",
    ]);
    expect(fixersForRule("legacy/todo-fixme-marker").map((f) => f.id)).toEqual([
      "remove-todo-marker",
    ]);
    expect(fixersForRule("legacy/empty-catch-block").map((f) => f.id)).toEqual([
      "annotate-empty-catch",
    ]);
  });

  it("gives every fixer at least one rule", () => {
    // A fixer with no handles can never be selected per-finding, so it would only ever run
    // via the repo-wide path — which is the behaviour C1 exists to end.
    for (const f of FIXERS) expect(f.handles.length).toBeGreaterThan(0);
  });
});

describe("legacyRuleIdFor", () => {
  it("matches the slug migration 003 assigns", () => {
    expect(legacyRuleIdFor("Leftover debug output")).toBe("legacy/leftover-debug-output");
    expect(legacyRuleIdFor("TODO/FIXME marker")).toBe("legacy/todo-fixme-marker");
  });

  it("does not emit a bare prefix for a title with no word characters", () => {
    expect(legacyRuleIdFor("!!!")).toBe("legacy/unknown");
  });
});
