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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const t0Flag = flag("t0", "");
const windowFlag = flag("window", "");

const outDir = flag("out", "benchmarks/calibration/datasets");
/**
 * Repos come from the committed corpus by default, not the command line.
 *
 * The selection is PRE-REGISTERED (`benchmarks/calibration/corpus.json`) so it cannot be
 * quietly revised once results are in — which is the one failure a calibration corpus cannot
 * recover from, because selecting on outcome produces a scorecard that measures the selection.
 * Explicit URLs on the command line override it for ad-hoc runs.
 */
let repos = argv.filter((a) => a.startsWith("http"));
let corpusT0: string | undefined;
let corpusWindow: number | undefined;
if (repos.length === 0) {
  const corpusPath = flag("corpus", "benchmarks/calibration/corpus.json");
  try {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
      t0?: string;
      windowMonths?: number;
      repos: Array<{ url: string }>;
    };
    repos = corpus.repos.map((r) => r.url);
    corpusT0 = corpus.t0;
    corpusWindow = corpus.windowMonths;
    console.log(`corpus: ${corpusPath} — ${repos.length} repos`);
  } catch (e) {
    console.error(`could not read ${corpusPath}: ${(e as Error).message}`);
    process.exit(2);
  }
}

const t0 = t0Flag || corpusT0 || "2023-01-01";
const windowMonths = Number(windowFlag || corpusWindow || 12);
if (!Number.isFinite(windowMonths) || windowMonths <= 0) {
  throw new Error("--window expects a positive number of months");
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
/**
 * Lines of code per file AT T0 — §5.3's mandatory control variable.
 *
 * "L2-regularised logistic regression, NLOC as an explicit control, so each marker earns weight
 * only for lift beyond file size." Without it the fit cannot separate a real organisational
 * signal from "this file is big", which is the strongest naive predictor in the entire
 * defect-prediction literature. Every coefficient would be partly a proxy for size.
 *
 * Read from the tree AT T0, not from the working copy: the working copy is today's code, and
 * using it would leak post-T0 information into a feature. One `ls-tree` plus one batched
 * `cat-file` rather than a process per file — 3827 files would otherwise be 3827 spawns.
 */
function nlocAtT0(dir: string, rev: string): Map<string, number> {
  const out = new Map<string, number>();
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-tree", "-r", rev], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return out;
  }

  const blobs: Array<{ sha: string; file: string }> = [];
  for (const line of listing.split("\n")) {
    // `<mode> blob <sha>\t<path>`
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m?.[1] && m[2] && isSource(m[2])) blobs.push({ sha: m[1], file: m[2] });
  }
  if (blobs.length === 0) return out;

  // No `encoding`: execFileSync then returns a Buffer, which is what the byte scan below
  // needs. Passing `encoding: "buffer"` is rejected outright when `input` is a string, and
  // decoding to utf8 would corrupt any non-UTF8 source file before it could be counted.
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: dir,
    input: `${blobs.map((b) => b.sha).join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });

  // `<sha> blob <size>\n<size bytes>\n` per entry, in request order.
  let off = 0;
  for (const b of blobs) {
    const nl = batch.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = batch.subarray(off, nl).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    const body = batch.subarray(nl + 1, nl + 1 + size);
    let lines = 0;
    for (const byte of body) if (byte === 0x0a) lines++;
    out.set(b.file, lines);
    off = nl + 1 + size + 1;
  }
  return out;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java)$/;

/**
 * Directories whose contents are not authored product code.
 *
 * `dist`/`build`/`out` are GENERATED — `moment/dist/locale/*.js` is the compiled twin of
 * `src/locale/*.js`, and including both counts one file twice while adding a second copy to
 * the negative class. Measured before this filter existed: 149 of 1430 rows (10.4%) were build
 * output, almost all of it moment's compiled locales.
 *
 * `test`/`spec` are excluded because a defect label means "a bug was found in this file", and a
 * test changing alongside a fix is the fix being VERIFIED, not the test being broken. `docs`
 * and `bench` are not shipped behaviour.
 *
 * `scripts` is deliberately NOT here: build tooling is authored code that really does have
 * bugs, and excluding it would be trimming the corpus to taste rather than to a rule.
 */
const NON_SOURCE_DIR =
  /(^|\/)(dist|client-dist|build|_build|out|generated|vendor|node_modules|test|tests|spec|specs|examples?|fixtures?|docs|doc|bench|benchmarks)\//;

/** Generated single-line bundles. Their line counts are meaningless as a size control. */
const GENERATED_FILE = /\.(min|bundle)\.(js|css)$/;

const isSource = (f: string): boolean =>
  SOURCE.test(f) && !f.startsWith(".github/") && !NON_SOURCE_DIR.test(f) && !GENERATED_FILE.test(f);

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
    // The last commit at or before T0 — the tree the features describe.
    let t0Rev = "";
    try {
      // `--first-parent` IS LOAD-BEARING. Without it, `rev-list --before` returns the newest
      // commit by DATE anywhere in the reachable graph — including histories grafted in from
      // other repositories. On socket.io that selected a commit from the merged-in
      // `socket.io-protocol` repo whose entire tree is 7 files (`Readme.md` + `test-suite/`),
      // so the dataset came back with 2 source files instead of 117. The main development line
      // is the first-parent line, and that is the tree T0 is supposed to name.
      t0Rev = execFileSync(
        "git",
        ["rev-list", "-1", `--before=${t0}`, "--first-parent", "HEAD"],
        { cwd: dir, encoding: "utf8" },
      ).trim();
    } catch {
      /* no commit before T0 */
    }
    if (!t0Rev) {
      console.log("no history before T0 — skipped");
      continue;
    }

    /**
     * THE DATASET IS THE T0 TREE, not every path the history ever mentioned.
     *
     * `signalsFromCommits` yields a row for every file touched in the window, including files
     * DELETED or RENAMED before T0. Those cannot have a size at T0, cannot be defective after
     * it, and are pure noise. Measured on `pallets/click`: 42 rows, of which only 18 existed at
     * T0 — 57% were ghosts of a `click/` -> `src/click/` move.
     *
     * Caught because NLOC came back null for them. Without the size control §5.3 mandates, they
     * would have sat in the dataset indefinitely, indistinguishable from real files.
     */
    const nloc = nlocAtT0(dir, t0Rev);
    const d = buildDataset(before, after, undefined, {
      includeFile: (f) => isSource(f) && nloc.has(f),
    });

    const files = d.files.map((f) => ({ ...f, nloc: nloc.get(f.file) ?? null }));
    const withNloc = files.filter((f) => f.nloc !== null).length;

    writeFileSync(
      path.join(outDir, `${name}.json`),
      `${JSON.stringify({ repo: url, t0, windowEnd, t0Rev, ...d, files, withNloc }, null, 2)}\n`,
    );

    const row = {
      repo: name,
      historyCommits: before.length,
      fixCommits: d.fixCommits,
      files: d.total,
      defective: d.defective,
      defectRate: Number((d.defectRate * 100).toFixed(1)),
      sweepingIgnored: d.sweepingCommitsIgnored,
      withNloc,
    };
    summary.push(row);
    console.log(
      `history=${row.historyCommits}c fixes=${row.fixCommits} files=${row.files} ` +
        `defective=${row.defective} rate=${row.defectRate}%` +
        (d.sweepingCommitsIgnored > 0 ? `  (${d.sweepingCommitsIgnored} sweeping ignored)` : ""),
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
