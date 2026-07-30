import { describe, expect, it } from "vitest";
import { auc } from "../src/metrics";
import { fitLogistic, predict, sigmoid, standardise, standardiser } from "../src/fit";
import { mulberry32 } from "../src/metrics";

describe("sigmoid", () => {
  it("is 0.5 at zero and monotonic", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(1)).toBeGreaterThan(sigmoid(0));
    expect(sigmoid(-1)).toBeLessThan(sigmoid(0));
  });

  it("does not overflow at extremes", () => {
    // `1/(1+Math.exp(-z))` overflows for large negative z; the branch exists for this.
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(Number.isNaN(sigmoid(-1000))).toBe(false);
  });
});

describe("standardiser", () => {
  it("centres and scales", () => {
    const { mean, sd } = standardiser([[1], [3], [5]]);
    expect(mean[0]).toBe(3);
    expect(sd[0]).toBeCloseTo(Math.sqrt(8 / 3), 10);
  });

  it("gives a constant column sd = 1 rather than dividing by zero", () => {
    // Otherwise the column standardises to NaN and poisons every coefficient in the model.
    const { sd } = standardiser([[5], [5], [5]]);
    expect(sd[0]).toBe(1);
    const z = standardise([[5]], [5], sd);
    expect(z[0]![0]).toBe(0);
    expect(Number.isNaN(z[0]![0]!)).toBe(false);
  });
});

describe("fitLogistic", () => {
  /** y depends on x0 only; x1 is noise. */
  function synthetic(n: number): { rows: number[][]; labels: boolean[] } {
    const rand = mulberry32(5);
    const rows: number[][] = [];
    const labels: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const x0 = rand() * 10 - 5;
      const x1 = rand() * 100; // deliberately a much larger scale
      rows.push([x0, x1]);
      labels.push(sigmoid(1.5 * x0) > rand());
    }
    return { rows, labels };
  }

  it("recovers the sign and dominance of the true predictor", () => {
    const { rows, labels } = synthetic(2000);
    const m = fitLogistic(rows, labels, { lambda: 0.01, iterations: 4000 });
    expect(m.weights[0]).toBeGreaterThan(0);
    // x1 is noise on a 10x larger scale. Standardisation is what stops that scale from
    // deciding the outcome.
    expect(Math.abs(m.weights[0]!)).toBeGreaterThan(Math.abs(m.weights[1]!) * 3);
  });

  it("ranks better than chance on data it was fit to", () => {
    const { rows, labels } = synthetic(1000);
    const m = fitLogistic(rows, labels, { lambda: 0.01, iterations: 3000 });
    expect(auc(predict(m, rows), labels)!).toBeGreaterThan(0.75);
  });

  it("shrinks weights as lambda grows", () => {
    const { rows, labels } = synthetic(800);
    const weak = fitLogistic(rows, labels, { lambda: 0.01, iterations: 2000 });
    const strong = fitLogistic(rows, labels, { lambda: 500, iterations: 2000 });
    expect(Math.abs(strong.weights[0]!)).toBeLessThan(Math.abs(weak.weights[0]!));
  });

  it("does not penalise the intercept", () => {
    // With a huge lambda the weights collapse, but the intercept must still track the base
    // rate. Penalising it would drag every prediction toward 0.5 regardless of prevalence.
    const rows = Array.from({ length: 400 }, (_, i) => [i % 7]);
    const labels = rows.map((_, i) => i % 10 === 0); // 10% positive
    const m = fitLogistic(rows, labels, { lambda: 1e6, iterations: 4000, learningRate: 0.5 });
    expect(sigmoid(m.intercept)).toBeGreaterThan(0.03);
    expect(sigmoid(m.intercept)).toBeLessThan(0.2);
  });

  it("is deterministic", () => {
    const { rows, labels } = synthetic(300);
    const a = fitLogistic(rows, labels, { lambda: 0.1 });
    const b = fitLogistic(rows, labels, { lambda: 0.1 });
    expect(a.weights).toEqual(b.weights);
    expect(a.intercept).toBe(b.intercept);
  });

  it("produces no NaN on a constant feature column", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i, 42]);
    const labels = rows.map((_, i) => i > 50);
    const m = fitLogistic(rows, labels, { lambda: 0.1 });
    expect(m.weights.every((w) => Number.isFinite(w))).toBe(true);
    expect(predict(m, rows).every(Number.isFinite)).toBe(true);
  });

  it("rejects mismatched inputs", () => {
    expect(() => fitLogistic([[1]], [true, false])).toThrow(/1 rows vs 2 labels/);
    expect(() => fitLogistic([], [])).toThrow(/no rows/);
  });
});

describe("predict", () => {
  it("standardises new rows with the TRAINING statistics", () => {
    // Re-standardising against the test set is a classic leak: the held-out repo's own mean
    // would inform its predictions.
    const rows = [[0], [10]];
    const m = fitLogistic(rows, [false, true], { lambda: 0.01, iterations: 2000 });
    expect(m.mean[0]).toBe(5);
    const p = predict(m, [[0], [10]]);
    expect(p[1]!).toBeGreaterThan(p[0]!);
  });
});
