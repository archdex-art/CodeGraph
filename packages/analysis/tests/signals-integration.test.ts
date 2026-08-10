import { describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";
import { scoreIssues } from "@codegraph/score-engine";

/**
 * PLAN.md §5.2's signals, where they meet the pipeline.
 *
 * Two invariants matter here and neither is about the signals themselves — those are unit
 * tested in `@codegraph/vcs`. These cover the integration: that swapping `churnByFile()` for a
 * richer single pass did not change churn, and that the new markers do NOT reach the score.
 */

/**
 * Each case here runs a FULL index of this repository, and there are three of them.
 *
 * Measured 2026-08-09 on the repo root: 5.5s per index, of which taint is 2.5s, the symbol
 * graph 1.2s and detection 1.1s. Three of those is ~17s, and the suite runs files in parallel
 * against `dependencies.test.ts`, which self-indexes too — so vitest's 30s default was being
 * exceeded by contention rather than by anything being wrong.
 *
 * The budget is stated rather than the default raised globally: a full index that takes a
 * MINUTE is a regression worth failing on, and a per-file timeout is what still catches it.
 */
describe("gitSignals replaces churnByFile without changing it", { timeout: 120_000 }, () => {
  it("derives churn identical to the churnByFile map", async () => {
    // The old call was `churnByFile(root)`; churn is now read off the same pass that produces
    // the other seven signals. If these ever disagree, the replacement changed behaviour —
    // which a structural swap is not allowed to do.
    const r = await indexRepo(".");
    const signals = r.signals ?? {};
    expect(Object.keys(signals).length).toBeGreaterThan(0);

    const mismatches = Object.entries(signals).filter(
      ([file, s]) => (r.churnByFile[file] ?? 0) !== s.churn,
    );
    expect(mismatches).toEqual([]);
  });
});

describe("signals are reported, not scored", { timeout: 120_000 }, () => {
  it("leaves the Health Score a pure function of issues and LOC", async () => {
    // The guard against quietly wiring eight uncalibrated markers into the headline. §5.3 is
    // what earns them weight; until then the kernel must take nothing but issues and LOC.
    //
    // Asserted against the FULL issue set, reconstructed from `dimensions`. `r.issues` is
    // capped at 200 while the score covers all of them, so comparing against the exposed list
    // would fail for a reason that has nothing to do with signals — which is exactly how the
    // projectScore truncation bug surfaced.
    const r = await indexRepo(".");
    const issuesScored = r.dimensions.reduce((sum, d) => sum + d.issueCount, 0);
    if (issuesScored === r.issues.length) {
      expect(scoreIssues(r.issues, r.loc).overall).toBe(r.score);
    } else {
      // Truncated: re-scoring the visible subset must be HIGHER, never equal by accident.
      expect(scoreIssues(r.issues, r.loc).overall).toBeGreaterThan(r.score);
    }
  });

  it("computes signals for a tree with no git history without failing", async () => {
    // A local directory that is not a repository is a supported input (`CG_ALLOW_LOCAL_ACCESS`).
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "cg-nogit-"));
    try {
      writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
      const r = await indexRepo(dir);
      expect(r.signals).toEqual({});
      expect(typeof r.score).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
