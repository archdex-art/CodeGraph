/**
 * `@codegraph/jobs` — the queue abstraction and the lease/heartbeat/retry policy
 * over it (LLD §1, HLD §5.1).
 *
 * Writes no SQL. LLD §8 makes `@codegraph/persistence` the only module allowed to,
 * and the split is deliberate rather than ceremonial: the SQL owns atomicity
 * (LLD §8.3's claim statement) while this package owns the decisions — how long a
 * lease lasts, how often to renew it, and what a handler's exception means. Those
 * are the parts worth testing without a database.
 *
 * The poll loop itself is NOT here: LLD §1 places it in `apps/worker/src/main.ts`.
 * This package is what that loop is built from.
 */

export type { JobQueue, EnqueueInput, EnqueueResult } from "./queue";
export { createJobQueue, readJob } from "./queue";

export type { RunnerOptions, Scheduler, Timer } from "./runner";
export { runJob } from "./runner";

export type {
  ClaimedJob,
  JobContext,
  JobHandler,
  JobKind,
  JobOutcome,
  JobStatus,
} from "./types";
export { isJobKind, isTerminal, JOB_KINDS, JOB_STATUSES, TERMINAL_STATUSES } from "./types";
