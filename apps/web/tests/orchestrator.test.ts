import { describe, it, expect } from "vitest";
import { runSwarm } from "@/lib/agents/orchestrator";
import type { RepoDetail, Issue } from "@/lib/types";

function emptyGraph() {
  return { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } };
}

function repoWithIssues(issues: Issue[], score = 50): RepoDetail {
  return {
    id: "r", url: "", name: "test", status: "done", sourceType: "git",
    score, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null, drift: null,
    loc: 100, languages: [], graphStats: { nodes: 0, edges: 0, files: 0, dirs: 0, dependencies: 0 },
    dimensions: [], issues, dependencies: [], churnByFile: {},
    tree: { name: "/", path: ".", children: [] },
    viz: { nodes: [], edges: [] } as any,
    modules: { nodes: [], edges: [] },
    symbolGraph: emptyGraph(),
  };
}

let n = 0;
function mkIssue(over: Partial<Issue>): Issue {
  return { id: `i${n++}`, dimension: "test_integrity", severity: 1, title: "t", file: "a.ts", line: 1, blastRadius: 1, ...over };
}

describe("runSwarm: no findings", () => {
  it("returns a clean-codebase summary and leaves the score unmoved when there are no issues", () => {
    const plan = runSwarm(repoWithIssues([], 90));
    expect(plan.totalFindings).toBe(0);
    expect(plan.summary).toMatch(/clean/i);
    expect(plan.projectedScore).toBe(90);
    expect(plan.buckets.P0).toHaveLength(0);
  });
});

describe("runSwarm: critic corroboration", () => {
  it("merges findings from two different agents within 2 lines of each other, keeps the higher severity, and boosts confidence", () => {
    const repo = repoWithIssues([
      mkIssue({ dimension: "security", severity: 5, confidence: 0.9, title: "Use of eval()", file: "a.ts", line: 10 }),
      mkIssue({ dimension: "dependency_hygiene", severity: 1, confidence: 0.8, title: "No lockfile committed", file: "a.ts", line: 11 }),
    ]);
    const plan = runSwarm(repo);
    // Two independent findings went in; critic must merge them into one locus.
    const merged = plan.topFindings.find((f) => f.file === "a.ts" && f.corroboratedBy && f.corroboratedBy.length > 0);
    expect(merged).toBeDefined();
    expect(merged!.agent).toBe("security"); // higher severity (5 > 1) wins as primary
    expect(merged!.corroboratedBy).toContain("dependency");
    expect(merged!.confidence).toBeCloseTo(Math.min(1, 0.9 + 0.15), 5);
  });

  it("does NOT merge findings more than 2 lines apart in the same file", () => {
    const repo = repoWithIssues([
      mkIssue({ dimension: "security", severity: 5, confidence: 0.9, file: "a.ts", line: 10 }),
      mkIssue({ dimension: "dependency_hygiene", severity: 1, confidence: 0.8, file: "a.ts", line: 20 }),
    ]);
    const plan = runSwarm(repo);
    expect(plan.totalFindings).toBe(2);
    expect(plan.topFindings.every((f) => !f.corroboratedBy || f.corroboratedBy.length === 0)).toBe(true);
  });

  it("does NOT merge findings in different files even on the same line", () => {
    const repo = repoWithIssues([
      mkIssue({ dimension: "security", severity: 5, confidence: 0.9, file: "a.ts", line: 10 }),
      mkIssue({ dimension: "dependency_hygiene", severity: 1, confidence: 0.8, file: "b.ts", line: 10 }),
    ]);
    const plan = runSwarm(repo);
    expect(plan.totalFindings).toBe(2);
  });
});

describe("runSwarm: judge score -> priority thresholds", () => {
  // Hand-computed against the actual formula (severity band 10 + (severity-1)*20, i.e.
  // 10/30/50/70/90 -- the MIDPOINT of each priority range, not its edge -- times a
  // [0.4, 1.6]-clamped modifier of blastFactor * churnFactor * confidence * effortBonus),
  // routed through the "test" agent (confidence: i.confidence, effort fixed to "M" ->
  // effortBonus 1.0, churn defaults to 1 -> churnFactor = 1 + log10(2)/6 ≈ 1.050) so every
  // input is fully controlled.
  it("assigns P0 to a high severity/confidence/blast-radius finding (score >= 70)", () => {
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 5, confidence: 1.0, blastRadius: 10 })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].priority).toBe("P0");
    expect(plan.topFindings[0].score!).toBeGreaterThanOrEqual(70);
  });

  it("assigns P1 to a mid-strength finding (40 <= score < 70)", () => {
    // Deliberately strong confidence/blast so a severity-2 finding (band 30,
    // needs modifier >= 1.33) crosses into P1 -- demonstrating the modifier
    // actually moves a finding a full band, not just wobbles within one.
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 2, confidence: 1.0, blastRadius: 20 })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].priority).toBe("P1");
    expect(plan.topFindings[0].score!).toBeGreaterThanOrEqual(40);
    expect(plan.topFindings[0].score!).toBeLessThan(70);
  });

  it("assigns P2 to a weak finding (20 <= score < 40)", () => {
    // A severity-2 finding (band 30) at a neutral modifier (~1.0) lands here --
    // this is the "typical" case the old formula got wrong (see below).
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 2, confidence: 0.7, blastRadius: 3 })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].priority).toBe("P2");
    expect(plan.topFindings[0].score!).toBeGreaterThanOrEqual(20);
    expect(plan.topFindings[0].score!).toBeLessThan(40);
  });

  it("assigns P3 to a very weak finding (score < 20)", () => {
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 1, confidence: 0.3, blastRadius: 1 })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].priority).toBe("P3");
    expect(plan.topFindings[0].score!).toBeLessThan(20);
  });

  it("always assigns P0 to a security finding with severity >= 4, regardless of the numeric score threshold", () => {
    // Deliberately low confidence/blast so the raw score formula alone would land well under 70 —
    // the security-specific override in priorityOf must still force P0.
    const repo = repoWithIssues([mkIssue({ dimension: "security", severity: 4, confidence: 0.2, blastRadius: 1, title: "Use of eval()" })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].agent).toBe("security");
    expect(plan.topFindings[0].priority).toBe("P0");
  });

  it("assigns P2, not P1, to a moderate finding that used to sit exactly on the P1 floor", () => {
    // Reproduces the real calibration bug, not a synthetic one: this is a
    // "large file" maintainability finding shaped exactly like the ones
    // measured on expressjs/express@a371447, where the old formula
    // (severity x blast x churnMult x confidence x effortBonus x 10) put a
    // bare-minimum instance of this finding at *exactly* 40 -- the P1 floor --
    // with nothing left below it, which is why P2/P3 were empty on that repo
    // (docs/REVIEW_2026-07-29.md, 2026-07-29 remediation pass).
    const repo = repoWithIssues([
      mkIssue({ dimension: "maintainability", severity: 2, confidence: 0.9, blastRadius: 1, title: "Large file (900 LOC)" }),
    ]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].agent).toBe("refactor");
    expect(plan.topFindings[0].priority).toBe("P2");
    expect(plan.topFindings[0].score!).toBeLessThan(40);
  });

  it("puts routine findings in P2 rather than P1, so the urgent buckets stay small", () => {
    // The observed failure was degenerate bucketing: on express, 59 of 59
    // findings landed in P0/P1 (P0:21 P1:38 P2:0 P3:0), so "P1" meant nothing.
    // 44 of those 59 were severity 2 -- deadcode, refactor, and low-severity
    // security all cluster there -- and the old formula scored a typical
    // severity-2 finding at ~40, exactly the P1 floor.
    //
    // Asserting P2 > P1 on a severity-2-dominated mix is what actually
    // discriminates the two models: under the old one these are all P1 (so
    // P2 is empty and this fails); under the new one a typical severity-2
    // finding sits mid-P2 and only an unusually strong one is promoted.
    // A looser "at least 3 buckets are non-empty" assertion passes under BOTH
    // models and therefore defends nothing -- verified, not assumed.
    const routine = Array.from({ length: 8 }, (_, i) =>
      mkIssue({ dimension: "test_integrity", severity: 2, confidence: 0.7, blastRadius: 2, file: `routine${i}.ts` })
    );
    const urgent = mkIssue({ dimension: "security", severity: 5, confidence: 1.0, blastRadius: 10, title: "Use of eval()", file: "urgent.ts" });
    const plan = runSwarm(repoWithIssues([...routine, urgent]));

    expect(plan.buckets.P2.length).toBeGreaterThan(plan.buckets.P1.length);
    expect(plan.buckets.P0.length).toBe(1); // only the genuine severity-5 security finding
    expect(plan.buckets.P0.length + plan.buckets.P1.length).toBeLessThan(plan.totalFindings);
  });

  it("still ranks a high-severity, high-confidence, well-corroborated finding above a low-severity, low-confidence one", () => {
    // The invariant the [0.4, 1.6] modifier clamp actually guarantees (see the
    // judgeScore doc comment): severity 5 at its floor always outranks
    // severity 1 at its ceiling. This is the B2-style guarantee -- it does NOT
    // claim severity dominates at every adjacent band, only at this extreme.
    const repo = repoWithIssues([
      mkIssue({ dimension: "security", severity: 5, confidence: 0.4, blastRadius: 0, title: "Use of eval()", file: "worst.ts" }),
      mkIssue({ dimension: "test_integrity", severity: 1, confidence: 1.0, blastRadius: 60, file: "best.ts" }),
    ]);
    const plan = runSwarm(repo);
    const worst = plan.topFindings.find((f) => f.file === "worst.ts")!;
    const best = plan.topFindings.find((f) => f.file === "best.ts")!;
    expect(worst.score!).toBeGreaterThan(best.score!);
  });
});

describe("runSwarm: projected score bounds", () => {
  it("never projects above 100 even with many P0/P1 findings", () => {
    const issues = Array.from({ length: 20 }, (_, i) =>
      mkIssue({ dimension: "security", severity: 5, confidence: 1.0, blastRadius: 20, file: `f${i}.ts`, line: 1, title: "Use of eval()" })
    );
    const plan = runSwarm(repoWithIssues(issues, 95));
    expect(plan.projectedScore).toBeLessThanOrEqual(100);
    expect(plan.projectedScore).toBe(100);
  });

  it("leaves the score unchanged when there are no P0/P1 findings to fix", () => {
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 1, confidence: 0.1, blastRadius: 1 })], 60);
    const plan = runSwarm(repo);
    expect(plan.buckets.P0).toHaveLength(0);
    expect(plan.buckets.P1).toHaveLength(0);
    expect(plan.projectedScore).toBe(60);
  });
});

describe("runSwarm: symbol-graph truncation (Task 6.14)", () => {
  it("surfaces the truncated flag on the plan and warns in the summary text, even with no findings", () => {
    const repo = repoWithIssues([], 80);
    (repo.symbolGraph as any).truncated = true;
    const plan = runSwarm(repo);
    expect(plan.truncated).toBe(true);
    expect(plan.summary).toMatch(/partial/i);
  });

  it("does not warn when the symbol graph was not truncated", () => {
    const plan = runSwarm(repoWithIssues([], 80));
    expect(plan.truncated).toBe(false);
    expect(plan.summary).not.toMatch(/partial/i);
  });
});

describe("projectScore refuses a truncated issue list", () => {
  /**
   * `repo.issues` is capped at 200 by the indexer while the score covers ALL issues, so
   * re-scoring the visible subset starts from a healthier baseline than the real one.
   * Measured on this repository: 858 issues found, 200 exposed, score 44, re-scoring the
   * exposed 200 gives 67 — so the projection reported ~67 regardless of what the fixes did.
   *
   * That is review C5's bug again: C5 replaced a linear guess with a real simulation, and the
   * simulation was then run over 23% of its input. `Math.max(repo.score, …)` clamped upward,
   * so the wrong number always looked plausible.
   *
   * The completeness check reads `dimensions`, which the scorer fills over every issue and
   * which is already persisted — so it cannot disagree with the score it guards.
   */
  const sec = (line: number): Issue =>
    ({
      id: `i${line}`, dimension: "security", severity: 5, confidence: 0.9,
      title: "Use of eval()", file: "src/a.ts", line, blastRadius: 1,
    }) as Issue;

  it("returns the current score unchanged when issues are truncated", async () => {
    const repo = repoWithIssues([sec(1), sec(2)], 40);
    // The scorer saw 858; only 2 are exposed.
    repo.dimensions = [
      { dimension: "security", score: 2, penalty: 1372, issueCount: 858 },
    ] as RepoDetail["dimensions"];

    const plan = await runSwarm(repo);
    expect(plan.projectedScore).toBe(40);
  });

  it("still projects when the list is complete", async () => {
    const repo = repoWithIssues([sec(1), sec(2)], 40);
    repo.dimensions = [
      { dimension: "security", score: 2, penalty: 20, issueCount: 2 },
    ] as RepoDetail["dimensions"];

    const plan = await runSwarm(repo);
    // Fixing everything it can see cannot leave the score where it was.
    expect(plan.projectedScore).toBeGreaterThanOrEqual(40);
  });
});
