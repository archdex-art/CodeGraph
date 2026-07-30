/**
 * `@codegraph/calibrate` — offline defect-prediction calibration (PLAN.md §5.3).
 *
 * Produces a LABELLED DATASET and stops. No fitting, no model, no inference: §5.3 ships
 * "the learned constants only — no model, no inference at runtime, no LLM", and a package that
 * could score at runtime would make that easy to violate later.
 *
 * Deliberately does NOT depend on `@codegraph/analysis`, enforced by the layering gate. A
 * calibration run must not be able to reach the scorer whose weights it is meant to be fitting.
 */
export {
  assertDisjoint,
  buildDataset,
  commitsFromLog,
  labelsFromWindow,
  LeakageError,
  type Dataset,
  type DatasetOptions,
  type LabelCommit,
  type LabelledFile,
} from "./label";

export { auc, bootstrapAucByRepo, mulberry32, type Interval } from "./metrics";
export {
  fitLogistic,
  predict,
  sigmoid,
  standardise,
  standardiser,
  type FitOptions,
  type Model,
} from "./fit";
export {
  columnScorer,
  leaveOneRepoOut,
  modelScorer,
  modelScorerCV,
  type EvaluationResult,
  type RepoData,
  type RepoResult,
} from "./evaluate";
