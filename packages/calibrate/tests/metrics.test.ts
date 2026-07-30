import { describe, expect, it } from "vitest";
import { auc, bootstrapAucByRepo, mulberry32 } from "../src/metrics";

/**
 * These are the numbers every downstream claim rests on, so they are checked against
 * hand-computable cases rather than against themselves.
 */

describe("auc", () => {
  it("is 1 for a perfect ranker", () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [false, false, true, true])).toBe(1);
  });

  it("is 0 for a perfectly inverted ranker", () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [false, false, true, true])).toBe(0);
  });

  it("is 0.5 for a constant score", () => {
    // Every value tied. A threshold sweep would return 1.0 or 0.0 depending on sort order;
    // the rank form gives the only defensible answer.
    expect(auc([1, 1, 1, 1], [true, false, true, false])).toBe(0.5);
  });

  it("matches a hand-computed Mann-Whitney case", () => {
    // pos = {3, 1}, neg = {2, 0}. Ranks ascending: 0->1, 1->2, 2->3, 3->4.
    // rankSumPos = 4 + 2 = 6. U = 6 - (2*3)/2 = 3. AUC = 3 / (2*2) = 0.75.
    expect(auc([3, 1, 2, 0], [true, true, false, false])).toBe(0.75);
  });

  it("handles ties across classes with midranks", () => {
    // pos = {2, 1}, neg = {2, 0}. The two 2s tie at midrank 3.5.
    // rankSumPos = 3.5 + 2 = 5.5. U = 5.5 - 3 = 2.5. AUC = 2.5/4 = 0.625.
    expect(auc([2, 1, 2, 0], [true, true, false, false])).toBe(0.625);
  });

  it("returns null when a class is absent", () => {
    // Undefined, not 0.5 — returning a number here would look like a result.
    expect(auc([1, 2, 3], [true, true, true])).toBeNull();
    expect(auc([1, 2, 3], [false, false, false])).toBeNull();
  });

  it("rejects mismatched lengths instead of scoring the overlap", () => {
    expect(() => auc([1, 2], [true])).toThrow(/2 scores vs 1 labels/);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("stays in [0,1)", () => {
    const r = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("bootstrapAucByRepo", () => {
  const perfect = (n: number) => ({
    scores: [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n }, (_, i) => 100 + i)],
    labels: [...Array<boolean>(n).fill(false), ...Array<boolean>(n).fill(true)],
  });

  it("brackets a perfect ranker at 1", () => {
    const ci = bootstrapAucByRepo([perfect(5), perfect(5), perfect(5)], { iterations: 200, seed: 1 })!;
    expect(ci.lo).toBe(1);
    expect(ci.hi).toBe(1);
  });

  it("is reproducible for a seed", () => {
    const g = [perfect(4), { scores: [5, 1, 3, 2], labels: [true, false, true, false] }];
    const a = bootstrapAucByRepo(g, { iterations: 300, seed: 11 })!;
    const b = bootstrapAucByRepo(g, { iterations: 300, seed: 11 })!;
    expect(a).toEqual(b);
  });

  it("returns null when fewer than two repos are usable", () => {
    // One repo cannot produce a cross-project interval, and a single-group bootstrap would
    // return a tight interval around a number that has no cross-project meaning.
    expect(bootstrapAucByRepo([perfect(5)], { iterations: 50 })).toBeNull();
    expect(
      bootstrapAucByRepo([perfect(5), { scores: [1, 2], labels: [true, true] }], { iterations: 50 }),
    ).toBeNull();
  });

  it("resamples repos, not rows — a wide interval for disagreeing repos", () => {
    // One repo where the score works perfectly, one where it is inverted. Resampling repos
    // must produce a WIDE interval; resampling rows would average them into false precision.
    const inverted = {
      scores: [100, 101, 0, 1],
      labels: [false, false, true, true],
    };
    const ci = bootstrapAucByRepo([perfect(4), inverted], { iterations: 500, seed: 3 })!;
    expect(ci.hi - ci.lo).toBeGreaterThan(0.4);
  });
});
