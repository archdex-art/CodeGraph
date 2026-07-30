/**
 * L2-regularised logistic regression (PLAN.md §5.3, step 3).
 *
 * Written out rather than pulled in, for the same reason as `metrics.ts`: the product ships no
 * ML dependency, and §5.3 wants learned CONSTANTS, not a model. What leaves this file is a
 * table of numbers.
 *
 * Batch gradient descent on the mean log-loss. The problem is tiny — a few thousand rows, ten
 * features, and a convex objective — so the sophistication of the optimiser buys nothing, while
 * every line of it has to be correct. Deterministic: no shuffling, no random init, so the same
 * dataset always yields the same coefficients.
 */

export interface FitOptions {
  /** L2 penalty. Applied to weights, never to the intercept. */
  readonly lambda?: number;
  readonly learningRate?: number;
  readonly iterations?: number;
  /** Stop when the mean log-loss improves by less than this. */
  readonly tolerance?: number;
}

export interface Model {
  readonly intercept: number;
  readonly weights: readonly number[];
  /** Column means and standard deviations used to standardise. Needed to score new rows. */
  readonly mean: readonly number[];
  readonly sd: readonly number[];
  readonly iterations: number;
  readonly logLoss: number;
}

/**
 * Column means and standard deviations.
 *
 * Standardisation is REQUIRED, not cosmetic: L2 penalises large coefficients, so on raw
 * features it would punish whichever marker happens to be measured in small units. `churn`
 * runs to the hundreds while `ownershipRatio` is bounded by 1 — unstandardised, the penalty
 * would flatten ownership toward zero purely for being a fraction.
 *
 * A zero-variance column gets sd = 1, so it standardises to all-zeros and the fit ignores it
 * rather than dividing by zero and producing NaN coefficients that poison every prediction.
 */
export function standardiser(rows: ReadonlyArray<readonly number[]>): {
  mean: number[];
  sd: number[];
} {
  const d = rows[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  const sd = new Array<number>(d).fill(0);
  if (rows.length === 0) return { mean, sd: sd.map(() => 1) };

  for (const r of rows) for (let j = 0; j < d; j++) mean[j]! += r[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= rows.length;

  for (const r of rows) for (let j = 0; j < d; j++) sd[j]! += (r[j]! - mean[j]!) ** 2;
  for (let j = 0; j < d; j++) {
    const v = Math.sqrt(sd[j]! / rows.length);
    sd[j] = v < 1e-12 ? 1 : v;
  }
  return { mean, sd };
}

export function standardise(
  rows: ReadonlyArray<readonly number[]>,
  mean: readonly number[],
  sd: readonly number[],
): number[][] {
  return rows.map((r) => r.map((v, j) => (v - mean[j]!) / sd[j]!));
}

/** Numerically stable logistic. `Math.exp` of a large positive overflows to Infinity. */
export function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

export function fitLogistic(
  rows: ReadonlyArray<readonly number[]>,
  labels: readonly boolean[],
  options: FitOptions = {},
): Model {
  if (rows.length !== labels.length) {
    throw new Error(`fitLogistic: ${rows.length} rows vs ${labels.length} labels`);
  }
  if (rows.length === 0) throw new Error("fitLogistic: no rows");

  const lambda = options.lambda ?? 1;
  const lr = options.learningRate ?? 0.1;
  const maxIter = options.iterations ?? 5000;
  const tol = options.tolerance ?? 1e-9;

  const { mean, sd } = standardiser(rows);
  const X = standardise(rows, mean, sd);
  const y = labels.map((l) => (l ? 1 : 0));
  const n = X.length;
  const d = X[0]!.length;

  let intercept = 0;
  const w = new Array<number>(d).fill(0);
  let prev = Infinity;
  let iter = 0;

  for (; iter < maxIter; iter++) {
    let gb = 0;
    const gw = new Array<number>(d).fill(0);
    let loss = 0;

    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = intercept;
      for (let j = 0; j < d; j++) z += w[j]! * xi[j]!;
      const p = sigmoid(z);
      const err = p - y[i]!;
      gb += err;
      for (let j = 0; j < d; j++) gw[j]! += err * xi[j]!;
      // Clamped so a saturated prediction cannot produce -Infinity and stall the stop test.
      const q = Math.min(Math.max(p, 1e-15), 1 - 1e-15);
      loss -= y[i]! * Math.log(q) + (1 - y[i]!) * Math.log(1 - q);
    }

    loss /= n;
    // The penalty is on WEIGHTS ONLY. Penalising the intercept would drag predictions toward
    // p = 0.5 regardless of the base rate, which at 15% positives is a real distortion.
    for (let j = 0; j < d; j++) loss += (lambda / (2 * n)) * w[j]! ** 2;

    intercept -= lr * (gb / n);
    /**
     * Decoupled weight decay with a CLAMPED factor.
     *
     * The naive form, `w -= lr * (grad + (lambda/n) * w)`, diverges whenever
     * `lr * lambda / n > 2`: the correction overshoots zero by more than it started from, and
     * the weights oscillate to Infinity and then NaN within a few dozen iterations. Reproduced
     * at lambda = 1e6, lr = 0.5, n = 400 — every coefficient came back NaN, and a NaN model
     * predicts NaN for every row, which `auc` would then rank arbitrarily. A scorecard built on
     * that would look like a number.
     *
     * Written as an explicit shrink factor clamped at zero, the limit is correct instead of
     * catastrophic: a large lambda shrinks the weights fully to zero, which is what infinite
     * regularisation MEANS.
     */
    const shrink = Math.max(0, 1 - (lr * lambda) / n);
    for (let j = 0; j < d; j++) w[j] = w[j]! * shrink - lr * (gw[j]! / n);

    if (Math.abs(prev - loss) < tol) {
      prev = loss;
      break;
    }
    prev = loss;
  }

  return { intercept, weights: w, mean, sd, iterations: iter, logLoss: prev };
}

/** Predicted probabilities for rows in the ORIGINAL feature space. */
export function predict(model: Model, rows: ReadonlyArray<readonly number[]>): number[] {
  return rows.map((r) => {
    let z = model.intercept;
    for (let j = 0; j < model.weights.length; j++) {
      z += model.weights[j]! * ((r[j]! - model.mean[j]!) / model.sd[j]!);
    }
    return sigmoid(z);
  });
}
