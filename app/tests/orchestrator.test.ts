import { describe, it, expect } from "vitest";
import { runSwarm } from "@/lib/agents/orchestrator";
import type { RepoDetail, Issue } from "@/lib/types";

function emptyGraph() {
  return { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } };
}

function repoWithIssues(issues: Issue[], score = 50): RepoDetail {
  return {
    id: "r", url: "", name: "test", status: "done", sourceType: "git",
    score, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null,
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
  // Hand-computed against the actual formula (severity * blast * churnMult * confidence * effortBonus * 10),
  // routed through the "test" agent (confidence: i.confidence, effort fixed to "M" -> effortBonus 1.0,
  // churn defaults to 1 -> churnMult = 1 + log10(2) ≈ 1.301) so every input is fully controlled.
  it("assigns P0 to a high severity/confidence/blast-radius finding (score >= 70)", () => {
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 5, confidence: 1.0, blastRadius: 10 })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].priority).toBe("P0");
    expect(plan.topFindings[0].score!).toBeGreaterThanOrEqual(70);
  });

  it("assigns P1 to a mid-strength finding (40 <= score < 70)", () => {
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 2, confidence: 0.7, blastRadius: 3 })]);
    const plan = runSwarm(repo);
    expect(plan.topFindings[0].priority).toBe("P1");
    expect(plan.topFindings[0].score!).toBeGreaterThanOrEqual(40);
    expect(plan.topFindings[0].score!).toBeLessThan(70);
  });

  it("assigns P2 to a weak finding (20 <= score < 40)", () => {
    const repo = repoWithIssues([mkIssue({ dimension: "test_integrity", severity: 1, confidence: 0.7, blastRadius: 3 })]);
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
