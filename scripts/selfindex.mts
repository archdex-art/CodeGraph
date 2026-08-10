/**
 * Reproduce the index figures the landing page publishes about CodeGraph itself.
 *
 * WHY THIS EXISTS. `scripts/bench.mts` is this idea pointed at `expressjs/express@a371447`:
 * it exists so the README's benchmark rows map to a command anyone can re-run, after three of
 * those rows drifted because nothing re-derived them. The landing page publishes a *different*
 * measurement — a cold run over this repository, broken down per stage — and it had no such
 * command, so it drifted the same way and further. It advertised "2.1s to index 327 files"
 * with a five-bar breakdown; that profile was taken on a 303-file tree (PLAN.md, 2026-07-30),
 * six of the eleven stages the pipeline now has did not exist when it was written, and the
 * largest one today (`taint`, added 2026-07-30) was missing from the chart entirely. The page's
 * own footer promised that the commands measuring its numbers are in the repo.
 *
 *   npm run selfindex
 *
 * Prints the per-stage timings the bar chart draws, the cold total the PROOF strip quotes, and
 * the TypeScript file count the caption names. `apps/web/tests/landing-claims.test.ts` asserts
 * the file count against the working tree. It deliberately does NOT assert the timings: a wall
 * clock measures the machine as much as the code, so those are published with a date instead,
 * the same way the README publishes its case count.
 */
import path from "node:path";

/**
 * The indexer refuses a local directory unless the operator opts in — a deployed instance must
 * only ever index what it cloned. Set for the same reason `bench.mts` sets it: this is a
 * developer command running against a checkout the developer already has.
 */
process.env.CG_ALLOW_LOCAL_ACCESS = "true";

const root = path.resolve(import.meta.dirname, "..");

const { indexRepo } = await import("../packages/analysis/src/indexer");

const started = Date.now();
const r = await indexRepo(root);
const wall = Date.now() - started;

const ts = r.languages.find((l) => l.language === "TypeScript");

console.log(`\n=== CodeGraph @ ${new Date().toISOString().slice(0, 10)} ===\n`);
console.log("Scan");
console.log(`  TypeScript files           : ${ts?.files ?? 0}`);
console.log(`  files analysed / seen      : ${r.coverage?.filesAnalysed} / ${r.coverage?.filesSeen}`);
console.log(`  LOC analysed               : ${r.coverage?.locAnalysed.toLocaleString()}`);
console.log("\nStages (ms)");
// `stageTimings` is optional on `IndexResult`: an index that failed before the first stage
// carries none. Printing nothing beats crashing the script that exists to report timings.
for (const [stage, ms] of Object.entries(r.stageTimings ?? {})) {
  console.log(`  ${stage.padEnd(27)}: ${ms}`);
}
console.log(`\n  cold total (wall)          : ${wall}ms\n`);
