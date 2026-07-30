import { describe, expect, it } from "vitest";
import {
  assertDisjoint,
  buildDataset,
  commitsFromLog,
  labelsFromWindow,
  LeakageError,
  type LabelCommit,
} from "../src/index";

/**
 * PLAN.md §5.3, step 2: "Score each file at T0 — the commit immediately before the window
 * opens. Scoring inside the window lets the fit see its own answer. This is the step that is
 * easiest to get wrong and hardest to detect afterward."
 *
 * "Hardest to detect" is the operative half. Leakage makes the numbers BETTER — a higher AUC, a
 * cleaner scorecard — so nothing downstream complains. These tests exist because the failure
 * mode is silent success.
 */

const DAY = 86_400;
const c = (
  at: number,
  files: string[],
  opts: { fix?: boolean; author?: string } = {},
): LabelCommit => ({
  author: opts.author ?? "Ada",
  at: at * DAY,
  isFix: opts.fix ?? false,
  files,
});

describe("leakage guard", () => {
  it("throws when a commit appears in both halves", () => {
    expect(() => assertDisjoint(["a", "b", "c"], ["c", "d"])).toThrow(LeakageError);
  });

  it("names the overlap, because a count alone is not debuggable", () => {
    expect(() => assertDisjoint(["a"], ["a"])).toThrow(/a/);
  });

  it("permits genuinely disjoint halves", () => {
    expect(() => assertDisjoint(["a", "b"], ["c", "d"])).not.toThrow();
  });

  it("refuses a dataset built from one commit list passed twice", () => {
    // The specific mistake: reusing `history` for both arguments. Cheap to make, invisible in
    // the output, and it produces a model that appears to predict perfectly.
    const commits = [c(1, ["a.ts"]), c(2, ["a.ts"], { fix: true })];
    expect(() =>
      buildDataset(commits, commits, { before: ["h1", "h2"], after: ["h1", "h2"] }),
    ).toThrow(LeakageError);
  });

  it("cannot be defeated by identical timestamps", () => {
    // Identity is the hash. Two commits can share a second, and rebases make timestamps a
    // worse key still.
    expect(() => assertDisjoint(["h1"], ["h2"])).not.toThrow();
  });
});

describe("labels come only from bug-fix commits", () => {
  it("labels a file touched by a fix", () => {
    const fixes = labelsFromWindow([c(10, ["a.ts"], { fix: true })]);
    expect(fixes.get("a.ts")).toBe(1);
  });

  it("does NOT label a file merely because it changed a lot", () => {
    // Churn is a FEATURE. Labelling on it teaches the model to predict its own input, which
    // scores beautifully and means nothing.
    const busy = Array.from({ length: 50 }, (_, i) => c(i + 1, ["hot.ts"]));
    expect(labelsFromWindow(busy).has("hot.ts")).toBe(false);
  });

  it("counts repeated fixes", () => {
    const fixes = labelsFromWindow([
      c(10, ["a.ts"], { fix: true }),
      c(11, ["a.ts"], { fix: true }),
      c(12, ["b.ts"], { fix: true }),
    ]);
    expect(fixes.get("a.ts")).toBe(2);
    expect(fixes.get("b.ts")).toBe(1);
  });
});

describe("buildDataset", () => {
  const history = [
    c(1, ["a.ts", "b.ts"]),
    c(2, ["a.ts"], { author: "Bob" }),
    c(3, ["b.ts"]),
    c(4, ["c.ts"]),
  ];

  it("takes features from history and labels from the window", () => {
    const window = [c(40, ["a.ts"], { fix: true })];
    const d = buildDataset(history, window);

    const a = d.files.find((f) => f.file === "a.ts")!;
    expect(a.defective).toBe(true);
    // Features describe a.ts BEFORE the window: 2 commits, 2 authors.
    expect(a.features.churn).toBe(2);
    expect(a.features.authors).toBe(2);

    expect(d.files.find((f) => f.file === "b.ts")!.defective).toBe(false);
  });

  it("excludes files that did not exist before T0", () => {
    // A file created during the window has no features, so predicting it would mean predicting
    // from nothing.
    const d = buildDataset(history, [c(40, ["brand-new.ts"], { fix: true })]);
    expect(d.files.map((f) => f.file)).not.toContain("brand-new.ts");
  });

  it("reports the base rate a fit has to beat", () => {
    const d = buildDataset(history, [c(40, ["a.ts"], { fix: true })]);
    expect(d.total).toBe(3);
    expect(d.defective).toBe(1);
    expect(d.defectRate).toBeCloseTo(1 / 3, 10);
  });

  it("never lets a window commit contribute to features", () => {
    // THE INVARIANT. Same history, but the window is enormous. If any of it leaked into the
    // features, churn would rise.
    const quiet = buildDataset(history, []);
    const loud = buildDataset(
      history,
      Array.from({ length: 100 }, (_, i) => c(40 + i, ["a.ts"], { fix: true })),
    );
    const churnOf = (d: typeof quiet) => d.files.find((f) => f.file === "a.ts")!.features.churn;
    expect(churnOf(loud)).toBe(churnOf(quiet));
  });

  it("returns an empty dataset rather than throwing on no history", () => {
    const d = buildDataset([], [c(40, ["a.ts"], { fix: true })]);
    expect(d.total).toBe(0);
    expect(d.defectRate).toBe(0);
  });
});

describe("commitsFromLog", () => {
  it("reuses the vcs parser rather than a second implementation", () => {
    const RS = "\x1e";
    const US = "\x1f";
    const raw = `${RS}abc${US}Ada${US}1000${US}fix: null deref\na.ts\n`;
    const [only] = commitsFromLog(raw);
    expect(only).toMatchObject({ author: "Ada", at: 1000, isFix: true, files: ["a.ts"] });
  });
});

describe("dataset scoping, learned from a real run", () => {
  const history = [c(1, ["lib/a.js", "History.md"]), c(2, ["lib/b.js"]), c(3, ["History.md"])];
  const window = [c(40, ["lib/a.js", "History.md"], { fix: true })];

  it("labels a changelog as defective when nothing filters it", () => {
    // Not a hypothetical. The first run against express@2023 returned `History.md` as the
    // top defective file — every fix commit touches the changelog, so it correlates perfectly
    // with defects and predicts nothing. `.github/workflows/ci.yml` came second.
    const d = buildDataset(history, window);
    expect(d.files.find((f) => f.file === "History.md")?.defective).toBe(true);
  });

  it("excludes it when the caller supplies a filter", () => {
    const d = buildDataset(history, window, undefined, {
      includeFile: (f) => f.endsWith(".js"),
    });
    expect(d.files.map((f) => f.file)).toEqual(["lib/a.js", "lib/b.js"]);
    expect(d.defective).toBe(1);
  });

  it("reports the fix-commit count, not just the file count", () => {
    // `total` flatters the sample: express gave 234 files and a 3.0% rate off FIVE fix
    // commits. A caller that only sees 234 will fit on noise.
    const d = buildDataset(history, window);
    expect(d.fixCommits).toBe(1);
    expect(d.total).toBeGreaterThan(d.fixCommits);
  });

  it("counts fix commits in the window, not fixes per file", () => {
    const d = buildDataset(history, [
      c(40, ["lib/a.js", "lib/b.js"], { fix: true }),
      c(41, ["lib/a.js"]),
    ]);
    // One fix commit touching two files is one commit.
    expect(d.fixCommits).toBe(1);
  });
});

describe("sweeping commits cannot manufacture labels", () => {
  /**
   * THE ANOMALY THIS PREVENTS, found by running the real corpus rather than by reasoning.
   *
   * date-fns's `Get rid of export default, fix type resolution` touches 1323 files and contains
   * the word "fix". It labelled all 1323 defective, which alone made date-fns 86% of the whole
   * corpus's positives (1284 of 1491). It is a codemod.
   *
   * The cap is 20, and it is MEASURED: across date-fns, scrapy, eslint and axios for 2023, 233
   * fix commits split 45.9% / 44.6% / 8.2% across 1, 2-5 and 6-20 files, with the 21-50 bucket
   * EMPTY. The three commits above it produced 71% of all file-labels.
   */
  it("ignores a fix commit that touches more files than the cap", () => {
    const wide = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const history = wide.map((f, i) => c(i + 1, [f]));
    const d = buildDataset(history, [c(50, wide, { fix: true })]);
    expect(d.defective).toBe(0);
    expect(d.sweepingCommitsIgnored).toBe(1);
  });

  it("still labels a normal multi-file fix", () => {
    const history = [c(1, ["a.ts"]), c(2, ["b.ts"])];
    const d = buildDataset(history, [c(50, ["a.ts", "b.ts"], { fix: true })]);
    expect(d.defective).toBe(2);
    expect(d.sweepingCommitsIgnored).toBe(0);
  });

  it("reports the cap rather than applying it silently", () => {
    const wide = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const d = buildDataset(wide.map((f, i) => c(i + 1, [f])), [
      c(50, wide, { fix: true }),
      c(51, wide, { fix: true }),
    ]);
    // A caller judging sample size must see that two "fixes" contributed nothing.
    expect(d.sweepingCommitsIgnored).toBe(2);
    expect(d.fixCommits).toBe(0);
  });

  it("honours an explicit cap override", () => {
    const wide = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const d = buildDataset(wide.map((f, i) => c(i + 1, [f])), [c(50, wide, { fix: true })], undefined, {
      maxFilesPerFix: 100,
    });
    expect(d.defective).toBe(40);
  });

  it("does not count a merge commit as a fix", () => {
    // A merge emits no file list, so it can label nothing — but it was inflating `fixCommits`.
    // The audit found `Merge pull request #1081 from brianloveswords/fix-readme` doing exactly
    // that.
    const d = buildDataset([c(1, ["a.ts"])], [c(50, [], { fix: true })]);
    expect(d.fixCommits).toBe(0);
    expect(d.defective).toBe(0);
  });
});
