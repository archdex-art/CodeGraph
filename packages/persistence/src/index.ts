/**
 * `@codegraph/persistence` — the only module that writes SQL (HLD §6, LLD §8).
 * Enforced by .dependency-cruiser.cjs: nothing else may import `node:sqlite`.
 *
 * Two things are deliberate about this surface.
 *
 * TENANT ISOLATION IS A TYPE-LEVEL OBLIGATION. Every scoped repo read takes a
 * `ViewerId` and there is no overload without one, so a route cannot forget it.
 * v1 relied on each route remembering to call `repoAccessDenied` — correct today,
 * one new route away from a cross-account leak. The unscoped reads that the
 * background job runner genuinely needs are named `*Unscoped` so they are
 * greppable rather than reachable by omitting an argument.
 *
 * SCHEMA CHANGES ARE NUMBERED MIGRATIONS. Not an `if (!cols.has(x)) ALTER` chain
 * (LLD §8.2): that could not express a data migration, and gave no way to tell
 * which version a database was at.
 */

export { DatabaseSync, dataDir, db, resetConnectionForTests } from "./db";
export type { SqliteDatabase, SqliteStatement } from "./sqlite";
export type { Migration } from "./migration-type";
export { runMigrations, schemaVersions } from "./migrate";
export { MIGRATIONS } from "./migrations/index";

export type {
  IndexedResultColumns,
  NewRepo,
  RepoFleetRow,
  RepoRow,
  RepoSummaryRow,
  WorkspaceLocation,
} from "./repos";
export {
  completeRepoIndex,
  deleteRepo,
  findRepo,
  findRepoUnscoped,
  insertRepo,
  listFleetRepos,
  listRepos,
  repoOwnerId,
  repoWorkspace,
  saveMode,
  setRepoError,
  setRepoHeadHash,
  setRepoStatus,
  setRepoWorkspace,
  setSaveMode,
} from "./repos";

export type { JobRow, QueuedJobRow, NewJob } from "./jobs";
export {
  findJob,
  insertJob,
  updateJob,
  TERMINAL_JOB_STATUSES,
  enqueueJob,
  claimJob,
  heartbeatJob,
  updateJobProgress,
  succeedJob,
  failJob,
  cancelJob,
  isJobCancelled,
  findQueuedJob,
  findLiveJobForRepo,
} from "./jobs";

export type { AnalysedIssue, NewRun } from "./runs";
export { findingById, legacyRuleId, recordRun, repoIdForFinding } from "./runs";

export type { CounterRow, MetricLabels } from "./metrics";
export {
  allCounters,
  counterValue,
  incrementCounter,
  renderPrometheus,
  resetCountersForTests,
} from "./metrics";

export { readSetting, writeSetting } from "./settings";

export type { FindingRow } from "./findings";
export {
  countFindingsByDimension,
  findingsForRun,
  isDimension,
  latestRunId,
  newFindingsSince,
  suppressFingerprint,
  suppressedFingerprints,
} from "./findings";

export type { TrashRow } from "./trash";
export {
  deleteTrashRow,
  deleteTrashRowsForRepo,
  findTrashRow,
  insertTrashRow,
  listTrashRows,
  trashRowsBeyondCap,
} from "./trash";
