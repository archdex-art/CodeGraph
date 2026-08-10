import { describe, expect, it } from "vitest";
import { FIXERS, fixersForRule, legacyRuleIdFor } from "@codegraph/remediate-engine";
import type { Issue } from "@codegraph/analysis-model";
import { autoFixable } from "@/lib/findings";

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
 * Titles the analyser emits that are ALSO intended to be auto-fixable
 * (`packages/analysis/src/indexer.ts`). Listed here rather than imported because the
 * binding must be pinned against the WORDS in that table — if a title is reworded, its
 * rule id changes and a fixer silently orphans. That is the failure this catches.
 *
 * `Leftover debug output`, `debugger statement` and `TODO/FIXME marker` are deliberately
 * ABSENT. They are still reported as findings; they simply have no auto-fix any more, because
 * the codemods that claimed them deleted a script's intended `print(...)` output and proposed
 * thirteen TODO-comment deletions in a single run. A finding without a fixer is honest; a
 * fixer whose diff a reviewer has to undo is not.
 */
const EMITTED_FIXABLE_TITLES = ["Empty catch block"] as const;

/** Emitted, fixable-LOOKING, and deliberately left to a human. */
const WITHDRAWN_FIXER_RULES = [
  "legacy/leftover-debug-output",
  "legacy/debugger-statement",
  "legacy/todo-fixme-marker",
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
    expect(fixersForRule("legacy/empty-catch-block").map((f) => f.id)).toEqual([
      "annotate-empty-catch",
    ]);
  });

  it("offers no fixer for the withdrawn classes, rather than a worse one", () => {
    // The regression this guards: re-adding a line-deleting codemod under a new name and
    // quietly rebinding these rules to it.
    for (const rule of WITHDRAWN_FIXER_RULES) {
      expect(fixersForRule(rule), rule).toEqual([]);
    }
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

/**
 * What the button is allowed to promise before it is pressed.
 *
 * The remediation panel offered "Generate verified fix PR" on every repository. On one with
 * nothing to fix it ran for four seconds and returned "no verification gate completed /
 * nothing to patch" — the product's headline verb apparently failing, in the place it is most
 * prominent. `autoFixable` is what lets the control say so up front instead, so these tests
 * are about a claim made to a user, not an internal lookup.
 */
describe("autoFixable — the promise the UI makes before running", () => {
  const issue = (over: Partial<Issue>): Issue => ({
    id: "i1", dimension: "correctness", severity: 3, title: "Empty catch block",
    file: "src/a.ts", line: 3, blastRadius: 1, ...over,
  });

  it("claims a finding by its RULE even when the title no longer slugs to it", () => {
    /*
     * The branch the title fallback cannot cover, and the realistic one. `Issue.rule` is
     * documented as the stable machine identity precisely because `title` is prose and
     * dynamic — "Large file (656 LOC)" re-slugs the moment the file grows a line. A finding
     * whose title has been reworded still carries the registry's key, and dropping the rule
     * lookup would disable a button that would have worked.
     */
    expect(autoFixable([issue({ rule: "legacy/empty-catch-block", title: "Catch block swallows the error" })])).toHaveLength(1);
  });

  it("claims a finding by its TITLE when the rule id is the detector's or absent", () => {
    /*
     * The mirror branch. A row back-filled by migration 003 carries `legacy/<slug-of-title>`,
     * which is the registry's key; today's detector emits its own id (`empty-catch`), which is
     * not. Checking only the rule would call every freshly detected empty catch unfixable.
     */
    expect(autoFixable([issue({ rule: "empty-catch" })])).toHaveLength(1);
    expect(autoFixable([issue({ rule: undefined })])).toHaveLength(1);
  });

  it("does not claim a finding no provider handles", () => {
    // The common case, and the one that was being mis-sold.
    expect(autoFixable([issue({ rule: "security/detect-unsafe-regex", title: "ReDoS-vulnerable regular expression" })])).toEqual([]);
  });

  it("does not offer to fix what the repository has already accepted", () => {
    // A suppressed finding is excluded from the score and from CI gates; patching it anyway
    // would hand back a diff for something the reader deliberately signed off.
    expect(autoFixable([issue({ rule: "legacy/empty-catch-block", suppressed: true })])).toEqual([]);
  });

  it("never claims a rule whose fixer was deliberately withdrawn", () => {
    /*
     * `WITHDRAWN_FIXER_RULES` are still reported and deliberately have no fixer — their
     * codemods deleted a script's intended output. If the predicate ever claimed one, the
     * button would promise a diff the registry cannot produce, which is the original bug
     * pointing the other way.
     */
    const withdrawn = WITHDRAWN_FIXER_RULES.map((rule) => issue({ rule, title: rule }));
    expect(autoFixable(withdrawn)).toEqual([]);
  });

  it("agrees with the registry across a mixed list", () => {
    const found = autoFixable([
      issue({ id: "a", rule: "security/detect-unsafe-regex", title: "ReDoS" }),
      issue({ id: "b", rule: "legacy/empty-catch-block" }),
      issue({ id: "c", rule: "legacy/todo-fixme-marker", title: "TODO/FIXME marker" }),
    ]);
    expect(found.map((f) => f.id)).toEqual(["b"]);
  });
});
