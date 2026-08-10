import { describe, expect, it } from "vitest";
import type { Issue } from "@codegraph/analysis-model";
import { groupByTier, ruleBreakdown } from "@/lib/findings";

/**
 * The counting is the claim.
 *
 * Everything the findings surface promises — "118 low-confidence findings you are not
 * being shown", "one rule is half your list", "12 of these are accepted" — is a number
 * this module produced. A rendered list that is merely sorted wrongly is a nuisance; a
 * count that is wrong is the product lying, and it lies in the direction of looking
 * cleaner than the repository is. So the arithmetic is tested here, without a DOM.
 */
function issue(over: Partial<Issue> & { id: string }): Issue {
  return {
    dimension: "security",
    severity: 3,
    confidence: 0.9,
    title: "Possible hardcoded secret",
    file: "src/a.ts",
    line: 1,
    blastRadius: 1,
    ...over,
  };
}

const CORPUS: Issue[] = [
  // Half the list is one rule, and one of its rows has been accepted.
  ...Array.from({ length: 6 }, (_, i) =>
    issue({ id: `fs${i}`, rule: "security/detect-non-literal-fs-filename", confidence: 0.3, file: `src/fs${i}.ts` })
  ),
  issue({ id: "fs-acc", rule: "security/detect-non-literal-fs-filename", confidence: 0.3, suppressed: true }),
  issue({ id: "s1", rule: "hardcoded-secret", confidence: 0.8 }),
  issue({ id: "s2", rule: "hardcoded-secret", confidence: 0.8 }),
  issue({ id: "m1", rule: "todo-marker", confidence: 0.5 }),
  // Persisted before `Issue.rule` existed, and dynamic in exactly the way the fallback
  // has to survive: two files at different sizes are ONE rule, not two.
  issue({ id: "old1", title: "Large file (656 LOC)", confidence: 0.9 }),
  issue({ id: "old2", title: "Large file (712 LOC)", confidence: 0.9 }),
];

describe("groupByTier", () => {
  it("splits on the confidence boundaries and keeps accepted out of its tier", () => {
    const counts = Object.fromEntries(
      groupByTier(CORPUS, "all").groups.map((g) => [g.key, g.issues.length])
    );
    // 0.8/0.9 high, 0.5 medium, 0.3 low; the accepted 0.3 row leaves `low` for `accepted`.
    expect(counts).toEqual({ high: 4, medium: 1, low: 6, accepted: 1 });
  });

  it("defaults to high + medium and counts what it is not showing", () => {
    const tiered = groupByTier(CORPUS, "default");
    expect(tiered.total).toBe(12);
    expect(tiered.shown).toBe(5);
    expect(tiered.hidden).toBe(7);
    // The closed groups are still rendered — with their counts, which is the point.
    expect(tiered.groups.filter((g) => !g.open).map((g) => [g.key, g.issues.length])).toEqual([
      ["low", 6],
      ["accepted", 1],
    ]);
  });

  it("opens exactly the requested group, so ?tier=low restores it", () => {
    const low = groupByTier(CORPUS, "low");
    expect(low.groups.filter((g) => g.open).map((g) => g.key)).toEqual(["low"]);
    expect(low.shown).toBe(6);
  });

  it("reports an empty list as empty rather than as clean", () => {
    expect(groupByTier([], "default")).toEqual({ groups: [], total: 0, shown: 0, hidden: 0 });
  });
});

describe("ruleBreakdown", () => {
  const breakdown = ruleBreakdown(CORPUS, 3);

  it("ranks by count and states each rule's share of the whole list", () => {
    expect(breakdown.rows.map((r) => [r.rule, r.count])).toEqual([
      ["security/detect-non-literal-fs-filename", 7],
      ["hardcoded-secret", 2],
      ["large-file", 2],
    ]);
    expect(breakdown.rows[0]!.share).toBeCloseTo(7 / 12, 5);
    expect(breakdown.rows[0]!.suppressed).toBe(1);
  });

  it("summarises the tail instead of dropping it", () => {
    expect(breakdown.restRules).toBe(1);
    expect(breakdown.restFindings).toBe(1);
    expect(breakdown.rows.reduce((n, r) => n + r.count, 0) + breakdown.restFindings).toBe(
      breakdown.total
    );
  });

  it("flags rows whose id is a title slug, so the UI never dresses prose as a rule id", () => {
    const derived = breakdown.rows.filter((r) => r.derived).map((r) => r.rule);
    // Both "Large file (N LOC)" rows collapse onto one derived id; nothing else is derived.
    expect(derived).toEqual(["large-file"]);
    expect(breakdown.derivedFindings).toBe(2);
  });

  it("carries every tier, including the ones at zero", () => {
    expect(breakdown.tiers).toEqual({ high: 4, medium: 1, low: 6, accepted: 1 });
    expect(ruleBreakdown([]).tiers).toEqual({ high: 0, medium: 0, low: 0, accepted: 0 });
  });
});
