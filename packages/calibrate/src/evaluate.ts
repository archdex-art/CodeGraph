import { fitLogistic, predict, type FitOptions, type Model } from "./fit";
import { auc, bootstrapAucByRepo, type Interval } from "./metrics";

/**
 * Cross-project evaluation (PLAN.md §5.3, step 4).
 *
 * "Cross-project ROC AUC with a confidence interval, plus per-repo. Compare against two
 * baselines that must be beaten: recent-churn, and prior-defect."
 *
 * LEAVE-ONE-REPOSITORY-OUT, never k-fold over rows. Random folds put files from the same
 * repository on both sides of the split, so the model sees that project's conventions, layout
 * and team during training and is then tested on more of the same. It scores far better and
 * measures nothing anyone cares about — the question is whether weights learned from OTHER
 * projects transfer to yours, which is precisely what holding out a whole repo asks.
 */

export interface RepoData {
  readonly repo: string;
  /** Feature rows in a fixed column order. */
  readonly rows: ReadonlyArray<readonly number[]>;
  readonly labels: readonly boolean[];
}

export interface RepoResult {
  readonly repo: string;
  readonly files: number;
  readonly defective: number;
  /** Null when the held-out repo has only one class — AUC is undefined there. */
  readonly auc: number | null;
}

export interface EvaluationResult {
  /** AUC over every held-out prediction pooled together. */
  readonly pooledAuc: number | null;
  readonly ci: Interval | null;
  readonly perRepo: readonly RepoResult[];
  /** Mean of the per-repo AUCs that are defined. Reported beside the pooled figure. */
  readonly meanRepoAuc: number | null;
  readonly reposScored: number;
}

/**
 * Score every repository with a model trained on all the others.
 *
 * `scoreOf` lets a baseline reuse this exact harness: a baseline that were evaluated through a
 * different code path could differ from the model by an accident of plumbing rather than by
 * predictive power, and the comparison is the entire point.
 */
export function leaveOneRepoOut(
  data: readonly RepoData[],
  scoreOf: (train: readonly RepoData[], test: RepoData) => number[],
  opts: { seed?: number; iterations?: number } = {},
): EvaluationResult {
  const perRepo: RepoResult[] = [];
  const groups: Array<{ scores: number[]; labels: boolean[] }> = [];
  const pooledScores: number[] = [];
  const pooledLabels: boolean[] = [];

  for (const test of data) {
    const train = data.filter((d) => d.repo !== test.repo);
    if (train.length === 0) continue;
    const scores = scoreOf(train, test);
    if (scores.length !== test.labels.length) {
      throw new Error(
        `leaveOneRepoOut: ${test.repo} produced ${scores.length} scores for ${test.labels.length} rows`,
      );
    }
    perRepo.push({
      repo: test.repo,
      files: test.labels.length,
      defective: test.labels.filter(Boolean).length,
      auc: auc(scores, test.labels),
    });
    groups.push({ scores, labels: [...test.labels] });
    pooledScores.push(...scores);
    pooledLabels.push(...test.labels);
  }

  const defined = perRepo.map((r) => r.auc).filter((a): a is number => a !== null);
  return {
    pooledAuc: auc(pooledScores, pooledLabels),
    ci: bootstrapAucByRepo(groups, { seed: opts.seed ?? 42, iterations: opts.iterations ?? 2000 }),
    perRepo,
    meanRepoAuc: defined.length === 0 ? null : defined.reduce((a, b) => a + b, 0) / defined.length,
    reposScored: defined.length,
  };
}

/** The fitted model, trained on the other repositories. */
export function modelScorer(options: FitOptions = {}) {
  return (train: readonly RepoData[], test: RepoData): number[] => {
    const rows = train.flatMap((d) => d.rows);
    const labels = train.flatMap((d) => [...d.labels]);
    const model: Model = fitLogistic(rows, labels, options);
    return predict(model, test.rows);
  };
}

/**
 * The fitted model, with L2 strength chosen by NESTED cross-validation.
 *
 * WHY THIS IS NOT TUNING ON THE TEST SET. The inner search runs leave-one-repo-out over the
 * TRAINING repositories only; the held-out repository is not visible to it at any point. Picking
 * lambda by looking at the outer result would be choosing the answer that scores best on the
 * thing being measured, which is the calibration equivalent of the leakage §5.3 warns about —
 * and it would be undetectable in the published number.
 *
 * WHY IT IS NEEDED HERE. The features are severely collinear — measured on this corpus,
 * churn~authors r=0.887, churn~priorDefect r=0.802, authors~priorDefect r=0.839. Collinear
 * inputs let a regression split one shared signal into large opposing coefficients: at
 * lambda = 1 (lambda/n ~ 0.0009, effectively unregularised) `churn` came out NEGATIVE at -0.71
 * despite having a positive univariate AUC of 0.671. Those coefficients fit the training repos
 * and transfer badly, which is exactly the failure L2 exists to prevent — at a strength chosen
 * rather than assumed.
 */
export function modelScorerCV(lambdas: readonly number[], options: FitOptions = {}) {
  return (train: readonly RepoData[], test: RepoData): number[] => {
    let best = lambdas[0]!;
    let bestAuc = -Infinity;

    for (const lambda of lambdas) {
      const scores: number[] = [];
      const labels: boolean[] = [];
      for (const inner of train) {
        const innerTrain = train.filter((d) => d.repo !== inner.repo);
        if (innerTrain.length === 0) continue;
        const rows = innerTrain.flatMap((d) => d.rows);
        const ys = innerTrain.flatMap((d) => [...d.labels]);
        if (!ys.some(Boolean) || !ys.some((y) => !y)) continue;
        const m = fitLogistic(rows, ys, { ...options, lambda });
        scores.push(...predict(m, inner.rows));
        labels.push(...inner.labels);
      }
      const a = auc(scores, labels);
      if (a !== null && a > bestAuc) {
        bestAuc = a;
        best = lambda;
      }
    }

    const rows = train.flatMap((d) => d.rows);
    const labels = train.flatMap((d) => [...d.labels]);
    return predict(fitLogistic(rows, labels, { ...options, lambda: best }), test.rows);
  };
}

/**
 * A single-column baseline.
 *
 * Ranks purely by one feature — no fitting, nothing learned. §5.3 names two that the model must
 * beat, and both are things a maintainer could compute in one line of shell. If nine
 * organisational markers and a regression cannot beat "sort by churn", they have not earned
 * their place in the score.
 */
export function columnScorer(index: number) {
  return (_train: readonly RepoData[], test: RepoData): number[] =>
    test.rows.map((r) => r[index] ?? 0);
}
