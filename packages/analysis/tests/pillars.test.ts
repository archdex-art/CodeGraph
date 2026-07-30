import { describe, expect, it } from "vitest";
import {
  DIMENSION_META,
  DIMENSION_PILLAR,
  PILLAR_META,
  weightWithinPillar,
  type Dimension,
  type Issue,
  type Pillar,
} from "@codegraph/analysis-model";
import { scoreIssues } from "../src/indexer";

/**
 * PLAN.md §5.1: "Three independent weight tables over one scoring kernel. Defect risk is the
 * surfaced number; maintainability and performance risk are co-equal, separately reported, and
 * never averaged in. A golden test locks the surfaced score byte-for-byte so the pillars cannot
 * bleed."
 *
 * The bleed is the thing to defend against. It does not arrive as someone deciding to blend the
 * pillars again — it arrives as a weight nudged, a dimension re-homed, or a `reduce` over the
 * wrong array, and the headline shifts without anyone noticing which question it now answers.
 */

// No `as Issue` cast: the compiler must enforce the shape. The first version of this fixture
// used one, omitted the required `blastRadius`, and every defect-risk score came back NaN —
// a fixture bug that a cast turned into a confusing test failure instead of a type error.
const issue = (dimension: Dimension, severity: number, over: Partial<Issue> = {}): Issue => ({
  file: "src/a.ts",
  line: 1,
  dimension,
  severity,
  confidence: 0.9,
  id: "i1",
  title: "t",
  blastRadius: 1,
  ...over,
});

describe("pillar membership", () => {
  it("assigns every dimension to exactly one pillar", () => {
    // A dimension with no pillar silently vanishes from every score.
    for (const d of Object.keys(DIMENSION_META) as Dimension[]) {
      expect(PILLAR_META[DIMENSION_PILLAR[d]]).toBeDefined();
    }
  });

  it("surfaces exactly one pillar", () => {
    // IDENTITY.md §4.2: 0-100 and the ONLY headline number. Two surfaced pillars is two
    // headlines, which is the thing the identity guard forbids.
    const surfaced = (Object.keys(PILLAR_META) as Pillar[]).filter((p) => PILLAR_META[p].surfaced);
    expect(surfaced).toEqual(["defect_risk"]);
  });

  it("keeps maintainability OUT of defect risk", () => {
    // The specific blend this split exists to undo — it was 0.22 of the old headline.
    expect(DIMENSION_PILLAR.maintainability).toBe("maintainability");
    expect(DIMENSION_PILLAR.maintainability).not.toBe("defect_risk");
  });

  it("normalises each pillar's weights to 1", () => {
    for (const pillar of Object.keys(PILLAR_META) as Pillar[]) {
      const members = (Object.keys(DIMENSION_META) as Dimension[]).filter(
        (d) => DIMENSION_PILLAR[d] === pillar,
      );
      if (members.length === 0) continue;
      const total = members.reduce((s, d) => s + weightWithinPillar(d), 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it("derives within-pillar weights from DIMENSION_META, not a second copy", () => {
    // correctness/security/dependency_hygiene/test_integrity = .26/.24/.16/.12, summing to .78.
    expect(weightWithinPillar("correctness")).toBeCloseTo(0.26 / 0.78, 10);
    // maintainability is alone in its pillar, so it carries all of it.
    expect(weightWithinPillar("maintainability")).toBe(1);
  });
});

describe("the surfaced score is defect risk ALONE", () => {
  it("does not move when only maintainability findings change", () => {
    // THE REGRESSION THIS LOCKS. Under the old blend, adding maintainability issues dropped the
    // headline — a tidiness problem reported as risk.
    const base = [issue("security", 4)];
    const withMaint = [...base, ...Array.from({ length: 40 }, () => issue("maintainability", 5))];

    expect(scoreIssues(withMaint, 5000).overall).toBe(scoreIssues(base, 5000).overall);
  });

  it("still moves when a defect-risk finding changes", () => {
    // The other half: locking the headline against maintainability must not deafen it entirely.
    const base = [issue("security", 4)];
    const worse = [...base, ...Array.from({ length: 40 }, () => issue("security", 5))];
    expect(scoreIssues(worse, 5000).overall).toBeLessThan(scoreIssues(base, 5000).overall);
  });

  it("equals the defect_risk pillar exactly", () => {
    const r = scoreIssues([issue("security", 4), issue("maintainability", 5)], 5000);
    const defect = r.pillars.find((p) => p.pillar === "defect_risk")!;
    expect(r.overall).toBe(defect.score);
  });

  it("reports maintainability separately and non-zero when it has findings", () => {
    const r = scoreIssues([issue("maintainability", 5)], 5000);
    const m = r.pillars.find((p) => p.pillar === "maintainability")!;
    expect(m.issueCount).toBe(1);
    expect(m.score).not.toBeNull();
  });
});

describe("an unmeasured pillar reports null, not a pass", () => {
  it("gives performance_risk a null score", () => {
    // No rule emits a performance finding, so there is nothing to score. Rendering 100 would
    // claim a clean bill of health for a check that never ran.
    const perf = scoreIssues([issue("security", 3)], 5000).pillars.find(
      (p) => p.pillar === "performance_risk",
    )!;
    expect(perf.score).toBeNull();
    expect(perf.dimensions).toEqual([]);
  });

  it("never lets a null pillar reach the surfaced number", () => {
    expect(typeof scoreIssues([issue("security", 3)], 5000).overall).toBe("number");
  });
});

describe("golden — the surfaced score is locked byte-for-byte", () => {
  /**
   * Fixed inputs, MEASURED outputs. Any change to the kernel, the weights, or the pillar
   * mapping moves these, and moving them must be a deliberate edit with a reason — which is
   * exactly the review conversation PLAN.md §5.1 wants to force.
   *
   * Chosen to SPREAD across the range. The first version of this table used a single finding
   * per case and every expected value landed in 98-100, so it would have passed through almost
   * any regression. A golden test whose cases do not discriminate is a golden test that locks
   * nothing.
   */
  const rep = (n: number, d: Dimension, sev: number, blastRadius = 1) =>
    Array.from({ length: n }, () => issue(d, sev, { blastRadius }));

  const cases: Array<[string, Issue[], number, number]> = [
    ["clean repo", [], 5000, 100],
    ["one critical security finding", [issue("security", 5)], 5000, 99],
    ["10 critical security findings", rep(10, "security", 5), 5000, 89],
    ["50 critical security findings", rep(50, "security", 5), 5000, 73],
    ["50 of them in widely-imported files", rep(50, "security", 5, 64), 5000, 69],
    // The headline does not move AT ALL for 50 maintainability findings. That is the split.
    ["50 maintainability findings only", rep(50, "maintainability", 5), 5000, 100],
    ["50 security findings in a 500k-LOC repo", rep(50, "security", 5), 500_000, 82],
    [
      "mixed across defect dimensions",
      [...rep(10, "security", 5), ...rep(10, "correctness", 3), ...rep(10, "test_integrity", 2)],
      5000,
      79,
    ],
  ];

  it.each(cases)("%s", (_name, issues, loc, expected) => {
    expect(scoreIssues(issues, loc).overall).toBe(expected);
  });

  it("locks the maintainability pillar too, so it cannot silently drift", () => {
    const fifty = Array.from({ length: 50 }, () => issue("maintainability", 5));
    const m = scoreIssues(fifty, 5000).pillars.find((p) => p.pillar === "maintainability")!;
    expect(m.score).toBe(11);
  });
});
