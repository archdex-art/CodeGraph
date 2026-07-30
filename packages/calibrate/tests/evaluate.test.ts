import { describe, expect, it } from "vitest";
import { columnScorer, leaveOneRepoOut, modelScorer, modelScorerCV, type RepoData } from "../src/index";
import { mulberry32 } from "../src/metrics";

/**
 * The harness that decides whether the Health Score's weights mean anything. Its own
 * correctness is checked against cases whose answer is known in advance.
 */

/** Repo where column 0 predicts the label perfectly. */
function clean(repo: string, n: number, seed: number): RepoData {
  const rand = mulberry32(seed);
  const rows: number[][] = [];
  const labels: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const defective = rand() < 0.3;
    rows.push([defective ? 8 + rand() : rand(), rand() * 5]);
    labels.push(defective);
  }
  return { repo, rows, labels };
}

describe("leaveOneRepoOut", () => {
  it("never trains on the repository it scores", () => {
    // The invariant the whole method rests on. The scorer asserts its training set excludes
    // the held-out repo; if the harness ever passed it, this throws.
    const data = [clean("a", 40, 1), clean("b", 40, 2), clean("c", 40, 3)];
    leaveOneRepoOut(data, (train, test) => {
      expect(train.map((t) => t.repo)).not.toContain(test.repo);
      expect(train).toHaveLength(2);
      return test.rows.map((r) => r[0]!);
    });
  });

  it("scores every repository exactly once", () => {
    const data = [clean("a", 20, 1), clean("b", 20, 2), clean("c", 20, 3)];
    const r = leaveOneRepoOut(data, columnScorer(0));
    expect(r.perRepo.map((x) => x.repo).sort()).toEqual(["a", "b", "c"]);
  });

  it("recovers a near-perfect AUC when the signal transfers", () => {
    const data = [clean("a", 60, 1), clean("b", 60, 2), clean("c", 60, 3)];
    const r = leaveOneRepoOut(data, modelScorer({ lambda: 0.1, iterations: 2000 }));
    expect(r.pooledAuc!).toBeGreaterThan(0.95);
    expect(r.ci!.lo).toBeGreaterThan(0.8);
  });

  it("reports null AUC for a held-out repo with one class, and excludes it from the mean", () => {
    const oneClass: RepoData = {
      repo: "allclean",
      rows: [[1, 1], [2, 2], [3, 3]],
      labels: [false, false, false],
    };
    const r = leaveOneRepoOut([clean("a", 30, 1), clean("b", 30, 2), oneClass], columnScorer(0));
    expect(r.perRepo.find((x) => x.repo === "allclean")!.auc).toBeNull();
    expect(r.reposScored).toBe(2);
  });

  it("throws when a scorer returns the wrong number of scores", () => {
    // Silent misalignment would score row i against label i+1 and still return a plausible AUC.
    expect(() =>
      leaveOneRepoOut([clean("a", 10, 1), clean("b", 10, 2)], (_t, test) =>
        test.rows.slice(1).map((r) => r[0]!),
      ),
    ).toThrow(/produced 9 scores for 10 rows/);
  });

  it("is deterministic", () => {
    const data = [clean("a", 30, 1), clean("b", 30, 2), clean("c", 30, 3)];
    const a = leaveOneRepoOut(data, modelScorer({ lambda: 0.1 }), { seed: 7 });
    const b = leaveOneRepoOut(data, modelScorer({ lambda: 0.1 }), { seed: 7 });
    expect(a.pooledAuc).toBe(b.pooledAuc);
    expect(a.ci).toEqual(b.ci);
  });
});

describe("columnScorer", () => {
  it("ranks by a single feature without fitting anything", () => {
    const test: RepoData = { repo: "t", rows: [[3, 0], [1, 0], [2, 0]], labels: [true, false, true] };
    expect(columnScorer(0)([], test)).toEqual([3, 1, 2]);
  });

  it("treats a missing column as zero rather than NaN", () => {
    const test: RepoData = { repo: "t", rows: [[1]], labels: [true] };
    expect(columnScorer(5)([], test)).toEqual([0]);
  });
});

describe("modelScorerCV — nested lambda selection", () => {
  it("never lets the inner search see the held-out repository", () => {
    // The whole defence. If lambda were chosen against the outer test repo, the published AUC
    // would be tuned on the thing it claims to measure — undetectable in the number itself.
    const data = [clean("a", 30, 1), clean("b", 30, 2), clean("c", 30, 3), clean("d", 30, 4)];
    const seen: string[][] = [];
    leaveOneRepoOut(data, (train, test) => {
      seen.push(train.map((t) => t.repo));
      expect(train.map((t) => t.repo)).not.toContain(test.repo);
      return modelScorerCV([0.1, 100], { iterations: 300 })(train, test);
    });
    expect(seen).toHaveLength(4);
  });

  it("produces one score per test row", () => {
    const data = [clean("a", 25, 1), clean("b", 25, 2), clean("c", 25, 3)];
    const r = leaveOneRepoOut(data, modelScorerCV([1, 100], { iterations: 300 }));
    for (const p of r.perRepo) expect(p.files).toBe(25);
  });

  it("is deterministic across runs", () => {
    const data = [clean("a", 25, 1), clean("b", 25, 2), clean("c", 25, 3)];
    const s = modelScorerCV([0.1, 10, 1000], { iterations: 400 });
    const one = s(data.slice(1), data[0]!);
    const two = s(data.slice(1), data[0]!);
    expect(one).toEqual(two);
  });

  it("falls back to the first lambda when no inner fold is scoreable", () => {
    // Two training repos where one has a single class: the inner AUC is undefined, and the
    // search must still return a usable model rather than NaN scores.
    const oneClass: RepoData = {
      repo: "z",
      rows: [[1, 1], [2, 2]],
      labels: [false, false],
    };
    const scores = modelScorerCV([5], { iterations: 200 })([oneClass, clean("a", 20, 9)], clean("b", 10, 3));
    expect(scores).toHaveLength(10);
    expect(scores.every(Number.isFinite)).toBe(true);
  });
});
