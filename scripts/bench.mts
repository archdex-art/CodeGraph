/**
 * Reproduce every benchmark number the README publishes.
 *
 * WHY THIS EXISTS. CLAUDE.md §5: "Don't claim in the README what the code doesn't do. Every
 * claim should map to a passing test." The benchmark rows cited a Health Score of 77 and
 * priority buckets of P0:21 · P1:38 · P2:0 — all three had drifted, because nothing re-derived
 * them when the model changed. The score moved when the pillars were split (P4 §5.1) and the
 * buckets moved when judge calibration was fixed, and the README kept publishing the old
 * figures with a straight face.
 *
 * A unit test cannot own this: it needs a network clone of a specific upstream commit, and a
 * test that silently skips without one is the same false comfort as the numbers it replaced.
 * So it is a script, it is committed, and the README points at it — anyone can re-run it and
 * check.
 *
 *   npm run bench
 *
 * Clones `expressjs/express` at the pinned commit into a temp directory, indexes it, runs the
 * swarm, runs the batch fixer, and prints exactly the figures the README quotes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CG_ALLOW_LOCAL_ACCESS = "true";

/** The commit the README cites. Pinned, because a moving target is not a benchmark. */
const REPO = "https://github.com/expressjs/express";
const COMMIT = "a371447";

const work = mkdtempSync(path.join(tmpdir(), "cg-bench-"));
const target = path.join(work, "express");

try {
  execFileSync("git", ["clone", "-q", "--depth", "50", REPO, target], { stdio: "pipe" });
  execFileSync("git", ["checkout", "-q", COMMIT], { cwd: target, stdio: "pipe" });
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();

  const { indexRepo } = await import("../packages/analysis/src/indexer");
  const { runSwarm } = await import("../apps/web/src/lib/agents/orchestrator");
  const { runFix } = await import("../apps/cli/src/fix");

  const r = await indexRepo(target);
  const issuesAll = r.dimensions.reduce((s, d) => s + d.issueCount, 0);

  console.log(`\n=== expressjs/express @ ${sha} ===\n`);
  console.log("Index");
  console.log(`  Health Score (defect risk) : ${r.score}`);
  console.log(`  issues                     : ${issuesAll}`);
  console.log(`  LOC                        : ${r.loc.toLocaleString()}`);
  console.log(`  dependencies               : ${r.graphStats.dependencies}`);
  console.log(`  symbols / edges            : ${r.symbolGraph.stats.symbols} / ${r.symbolGraph.stats.edges}`);
  console.log(`  resolved call edges        : ${r.symbolGraph.stats.resolvedCalls}`);
  console.log(`  files analysed / seen      : ${r.coverage?.filesAnalysed} / ${r.coverage?.filesSeen}`);
  console.log(`  dimensions                 : ${r.dimensions.map((d) => `${d.dimension}=${d.score}`).join(" ")}`);

  const repo = {
    id: "bench", url: REPO, name: "expressjs/express", status: "done", sourceType: "git",
    score: r.score, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null,
    loc: r.loc, languages: r.languages, graphStats: r.graphStats, dimensions: r.dimensions,
    issues: r.issues, dependencies: r.dependencies, churnByFile: r.churnByFile,
    tree: r.tree, viz: r.viz, modules: r.modules, symbolGraph: r.symbolGraph,
  } as unknown as Parameters<typeof runSwarm>[0];

  const plan = await runSwarm(repo);
  const buckets = Object.fromEntries(
    Object.entries(plan.buckets).map(([k, v]) => [k, (v as unknown[]).length]),
  );
  console.log("\nSwarm");
  console.log(`  findings                   : ${plan.totalFindings}`);
  console.log(`  active specialists         : ${plan.agents.filter((a) => a.findings > 0).length} of ${plan.agents.length}`);
  console.log(`  buckets                    : ${Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join(" · ")}`);
  console.log(`  per specialist             : ${plan.agents.map((a) => `${a.agent}=${a.findings}`).join(" ")}`);
  console.log(`  projected (simulated)      : ${plan.repoScore} -> ${plan.projectedScore}`);

  const fix = await runFix({ repo: target, verify: false, json: true, testTimeout: 300 });
  console.log("\nRemediation (batch, measured by re-index — not a projection)");
  console.log(`  edits / files              : ${fix.editCount} / ${fix.filesChanged}`);
  console.log(`  Health Score               : ${fix.scoreBefore} -> ${fix.scoreAfter}`);
  console.log(`  issues                     : ${fix.issuesBefore} -> ${fix.issuesAfter}`);
  console.log(`  verification level         : ${fix.record?.level}`);
  for (const g of fix.record?.gates ?? []) {
    console.log(`    ${g.gate.padEnd(11)} ${g.status}${g.reason ? ` — ${g.reason}` : ""}`);
  }
  console.log("");
} finally {
  rmSync(work, { recursive: true, force: true });
}
