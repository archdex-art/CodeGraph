/**
 * Build a labelled defect dataset for score calibration (PLAN.md §5.3).
 *
 *   npm run calibrate -- --t0 2014-01-01 --window 6 \
 *     https://github.com/expressjs/express https://github.com/lodash/lodash
 *
 * Clones each repo, computes organisational features from history strictly BEFORE `--t0`, and
 * labels a source file defective if a bug-fix commit touched it within `--window` months AFTER
 * it. Writes one JSON dataset per repo plus a combined summary.
 *
 * IT STOPS AT THE DATASET. No regression, no model. §5.3 ships "the learned constants only — no
 * model, no inference at runtime", and the fit is a separate offline step whose output is a
 * table of numbers a human reads before anything is committed.
 *
 * WHAT ONE REPO IS WORTH, measured on `expressjs/express` before writing this:
 *
 *   T0=2023-01-01   5 fix commits   152 source files    2 defective   1.3%
 *   T0=2019-01-01   3 fix commits   152 source files    1 defective   0.7%
 *   T0=2014-01-01  48 fix commits   146 source files    7 defective   4.8%
 *
 * Seven positives from the busiest six months of a major framework. That is why §5.3 says ~15
 * repos, and it is also why this prints the fix-commit count next to every rate: a 4.8% figure
 * over 7 files reads like a statistic and is a coin flip.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitLogRange } from "../packages/vcs/src/signals";
import { buildDataset, commitsFromLog } from "../packages/calibrate/src/index";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} expects a value`);
  return v;
};

const t0 = flag("t0", "2014-01-01");
const windowMonths = Number(flag("window", "6"));
if (!Number.isFinite(windowMonths) || windowMonths <= 0) {
  throw new Error("--window expects a positive number of months");
}
const outDir = flag("out", "benchmarks/calibration");
const repos = argv.filter((a) => a.startsWith("http"));
if (repos.length === 0) {
  console.error("usage: npm run calibrate -- [--t0 YYYY-MM-DD] [--window 6] <repo-url>...");
  process.exit(2);
}

/** Window end = T0 + N months, computed in UTC so it does not drift with the runner's zone. */
const end = new Date(`${t0}T00:00:00Z`);
end.setUTCMonth(end.getUTCMonth() + windowMonths);
const windowEnd = end.toISOString().slice(0, 10);

/**
 * Which files the dataset covers.
 *
 * Supplied here rather than inside `@codegraph/calibrate`, which knows nothing about languages
 * by design. Without it the top "defective" file on express is `History.md` — a changelog every
 * fix commit touches, so it correlates perfectly and predicts nothing.
 */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java)$/;
const isSource = (f: string): boolean =>
  SOURCE.test(f) &&
  !f.startsWith(".github/") &&
  !/(^|\/)(test|tests|spec|examples?|fixtures?|node_modules)\//.test(f);

mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "cg-calibrate-"));
const summary: Array<Record<string, unknown>> = [];

try {
  for (const url of repos) {
    const name = url.replace(/\.git$/, "").split("/").slice(-2).join("__");
    const dir = path.join(scratch, name);
    process.stdout.write(`${name} … `);
    try {
      // Full history: features need everything before T0, so a shallow clone would silently
      // truncate them and produce confidently wrong churn.
      execFileSync("git", ["clone", "-q", "--filter=blob:none", url, dir], { stdio: "pipe" });
    } catch {
      console.log("clone failed — skipped");
      continue;
    }

    const before = commitsFromLog(gitLogRange(dir, { since: "1990-01-01", until: t0 }));
    const after = commitsFromLog(gitLogRange(dir, { since: t0, until: windowEnd }));
    const d = buildDataset(before, after, undefined, { includeFile: isSource });

    writeFileSync(
      path.join(outDir, `${name}.json`),
      `${JSON.stringify({ repo: url, t0, windowEnd, ...d }, null, 2)}\n`,
    );

    const row = {
      repo: name,
      historyCommits: before.length,
      fixCommits: d.fixCommits,
      files: d.total,
      defective: d.defective,
      defectRate: Number((d.defectRate * 100).toFixed(1)),
    };
    summary.push(row);
    console.log(
      `history=${row.historyCommits}c fixes=${row.fixCommits} files=${row.files} ` +
        `defective=${row.defective} rate=${row.defectRate}%`,
    );
  }

  const totalFix = summary.reduce((s, r) => s + (r.fixCommits as number), 0);
  const totalPos = summary.reduce((s, r) => s + (r.defective as number), 0);
  writeFileSync(
    path.join(outDir, "summary.json"),
    `${JSON.stringify({ t0, windowEnd, repos: summary, totalFixCommits: totalFix, totalDefective: totalPos }, null, 2)}\n`,
  );

  console.log(`\n${summary.length} repo(s) · ${totalFix} fix commits · ${totalPos} defective files`);
  console.log(`written to ${outDir}/`);
  if (totalPos < 100) {
    // Said plainly rather than left for the fit to discover. L2 logistic regression over nine
    // features needs far more than this before its coefficients mean anything.
    console.log(
      `\nWARNING: ${totalPos} positive examples is NOT enough to fit nine features on. ` +
        `Add repos or widen --window before treating any coefficient as real.`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
