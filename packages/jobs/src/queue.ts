import {
  cancelJob,
  claimJob,
  enqueueJob,
  failJob,
  findLiveJobForRepo,
  findQueuedJob,
  heartbeatJob,
  isJobCancelled,
  succeedJob,
  updateJobProgress,
} from "@codegraph/persistence";
import { isJobKind, type ClaimedJob, type JobKind } from "./types";

/**
 * The queue, as the worker and the web tier see it.
 *
 * An interface rather than direct persistence calls for one concrete reason: the
 * runner's behaviour under lease loss, cancellation, and retry is the part most
 * worth testing, and testing it against real SQLite would mean provoking a
 * split-brain by manipulating timestamps in a database. With this seam the runner
 * tests drive those transitions directly, while the SQL itself is tested against
 * a real file in `packages/persistence/tests/jobs-queue.test.ts`. Neither test
 * has to fake what the other proves.
 */
export interface JobQueue {
  enqueue(input: EnqueueInput): EnqueueResult;
  claim(workerId: string, leaseMs: number): ClaimedJob | null;
  heartbeat(jobId: string, workerId: string, leaseMs: number): boolean;
  progress(
    jobId: string,
    workerId: string,
    percent: number,
    stage: string,
    message: string
  ): boolean;
  succeed(jobId: string, workerId: string, message: string): void;
  fail(jobId: string, workerId: string, error: string, permanent?: boolean): { willRetry: boolean };
  cancel(jobId: string): boolean;
  isCancelled(jobId: string): boolean;
  /** The per-repo mutex read (HLD §17 P2). */
  liveJobForRepo(repoId: string): { id: string; status: string } | null;
}

export interface EnqueueInput {
  readonly id: string;
  readonly repoId: string;
  readonly kind: JobKind;
  readonly payload: unknown;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly idempotencyKey?: string | null;
}

export type EnqueueResult =
  | { readonly ok: true; readonly jobId: string; readonly deduplicated: boolean }
  /**
   * Rejected by the per-repo mutex. Not an exception: a second analyse request
   * for a repo already being analysed is an ordinary thing for a user to do
   * (double-click, two tabs), and the caller wants the in-flight job's id so it
   * can attach to that progress stream instead of an error to render.
   */
  | { readonly ok: false; readonly reason: "repo-busy"; readonly activeJobId: string };

/**
 * Percent is clamped rather than rejected.
 *
 * A handler computing `done / total * 100` can produce 100.4 or a NaN on an empty
 * total, and a progress report is not worth failing a real analysis over. The
 * clamp keeps the column's meaning intact without giving handlers a way to write
 * nonsense into it.
 */
function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * Queue backed by `@codegraph/persistence`.
 *
 * A factory, not a class with fields, and no module-level state — LLD §1.1 bans
 * mutable module state in packages (retiring review B4).
 */
export function createJobQueue(): JobQueue {
  return {
    enqueue(input) {
      // Per-repo mutex. Two concurrent analyses of one repository clone into the
      // same workspace directory and race on every file in it, so this is checked
      // before the insert rather than left to the handlers to survive.
      //
      // This is a check-then-insert, so it is not by itself a guarantee under
      // concurrency; `idempotencyKey` is what closes that window at the database
      // (`idx_jobs_idem`), and callers enqueueing analysis pass one. The mutex's
      // job is to give a useful answer — the active job's id — not to be the
      // last line of defence.
      const live = findLiveJobForRepo(input.repoId);
      if (live) {
        return { ok: false, reason: "repo-busy", activeJobId: live.id };
      }

      const result = enqueueJob({
        id: input.id,
        repoId: input.repoId,
        kind: input.kind,
        payload: input.payload,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        idempotencyKey: input.idempotencyKey ?? null,
      });
      return { ok: true, jobId: result.id, deduplicated: result.deduplicated };
    },

    claim(workerId, leaseMs) {
      const row = claimJob(workerId, Date.now() + leaseMs);
      if (!row) return null;

      // An unrecognised `kind` is data the queue cannot dispatch. Surfacing it as
      // a claimed job with a bad kind would push the decision into every handler;
      // instead the runner fails it once, visibly, with the offending value.
      const kind: JobKind = isJobKind(row.kind) ? row.kind : "analyze";

      return {
        id: row.id,
        repoId: row.repo_id,
        kind,
        payload: parsePayload(row.payload_json),
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        workerId,
      };
    },

    heartbeat(jobId, workerId, leaseMs) {
      return heartbeatJob(jobId, workerId, Date.now() + leaseMs);
    },

    progress(jobId, workerId, percent, stage, message) {
      return updateJobProgress(jobId, workerId, clampPercent(percent), stage, message);
    },

    succeed(jobId, workerId, message) {
      succeedJob(jobId, workerId, message);
    },

    fail(jobId, workerId, error, permanent) {
      return failJob(jobId, workerId, error, permanent ?? false);
    },

    cancel(jobId) {
      return cancelJob(jobId);
    },

    isCancelled(jobId) {
      return isJobCancelled(jobId);
    },

    liveJobForRepo(repoId) {
      const row = findLiveJobForRepo(repoId);
      return row ? { id: row.id, status: row.status } : null;
    },
  };
}

/**
 * `payload_json` is a text column, so it can hold anything a past version wrote.
 * Returning `{}` on unparseable JSON rather than throwing keeps one corrupt row
 * from wedging the poll loop: the handler then rejects the empty payload and the
 * job fails on its own merits, with its own error message.
 */
function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Re-exported so a caller can read a job's public state without persistence. */
export function readJob(jobId: string): {
  id: string;
  repoId: string;
  status: string;
  progress: number;
  stage: string | null;
  message: string;
  error: string | null;
  attempts: number;
} | null {
  const row = findQueuedJob(jobId);
  if (!row) return null;
  return {
    id: row.id,
    repoId: row.repo_id,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    message: row.message,
    error: row.error,
    attempts: row.attempts,
  };
}
