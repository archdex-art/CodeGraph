import { serializeError, type Logger } from "@codegraph/observability";
import type { JobQueue } from "./queue";
import type { ClaimedJob, JobContext, JobHandler, JobOutcome } from "./types";

/**
 * Runs a single claimed job: heartbeat while it works, cooperative cancellation,
 * and one queue write-back at the end.
 *
 * This is the "lease · heartbeat · retry" box in HLD §5.1. It is separate from the
 * poll loop in `apps/worker/src/main.ts` so that the interesting behaviour — what
 * happens when a lease is lost, when a handler throws, when cancellation arrives
 * mid-run — is testable without a process, a timer wall-clock, or a database.
 */

export interface RunnerOptions {
  readonly queue: JobQueue;
  readonly logger: Logger;
  /** Lease length. The heartbeat renews at a fraction of this — see `HEARTBEAT_DIVISOR`. */
  readonly leaseMs: number;
  /** Injectable for tests; defaults to `setInterval`/`clearInterval`. */
  readonly scheduler?: Scheduler;
}

export interface Scheduler {
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}

export type Timer = ReturnType<typeof setInterval>;

/**
 * Heartbeat at a third of the lease.
 *
 * Two missed beats must not lose the lease, because a single long synchronous
 * parse can block the event loop past one interval — the tree-sitter path does
 * exactly this. At a third, the job survives two consecutive misses and only loses
 * its lease when it has genuinely stopped making progress, which is the condition
 * reclaim is for.
 */
const HEARTBEAT_DIVISOR = 3;

const defaultScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer),
};

/**
 * Run one job to completion and record the outcome.
 *
 * Never throws. A handler's exception becomes a `failed` outcome, because the poll
 * loop must survive any job — a worker that dies on a bad repository is a worker
 * that stops processing the queue, which is the failure mode the separate process
 * was supposed to remove rather than relocate.
 */
export async function runJob(
  job: ClaimedJob,
  handler: JobHandler,
  options: RunnerOptions
): Promise<JobOutcome> {
  const { queue, logger, leaseMs } = options;
  const scheduler = options.scheduler ?? defaultScheduler;

  // Set by the heartbeat the moment the queue reports the lease gone, so the
  // handler's next `progress()` or `cancelled()` call tells it to stop.
  let leaseLost = false;
  let cancelled = false;

  const heartbeat = scheduler.setInterval(() => {
    if (!queue.heartbeat(job.id, job.workerId, leaseMs)) {
      leaseLost = true;
      logger.warn("job lease lost", { jobId: job.id, workerId: job.workerId });
    }
  }, Math.max(1, Math.floor(leaseMs / HEARTBEAT_DIVISOR)));

  const ctx: JobContext = {
    jobId: job.id,
    repoId: job.repoId,
    attempts: job.attempts,
    progress(percent, stage, message) {
      if (leaseLost) return false;
      const held = queue.progress(job.id, job.workerId, percent, stage, message);
      if (!held) leaseLost = true;
      return held;
    },
    cancelled() {
      // Cached once true: a handler polling this in a loop should not pay a query
      // per iteration, and cancellation never un-happens.
      if (!cancelled && queue.isCancelled(job.id)) cancelled = true;
      return cancelled;
    },
  };

  try {
    await handler(job.payload, ctx);

    // Order matters. Lease loss is checked before cancellation and before
    // success, because a worker that no longer owns the job must not write ANY
    // terminal state — the new owner is running it and will write its own.
    if (leaseLost) {
      logger.warn("job abandoned after lease loss", { jobId: job.id });
      return { kind: "lease-lost" };
    }
    if (ctx.cancelled()) {
      // The cancelling request already set the terminal status; writing
      // `succeeded` here would overwrite the user's cancellation with a lie.
      logger.info("job cancelled", { jobId: job.id });
      return { kind: "cancelled" };
    }

    queue.succeed(job.id, job.workerId, "Complete");
    return { kind: "succeeded" };
  } catch (error) {
    if (leaseLost) {
      // The throw is very likely a consequence of the takeover (the new owner
      // moved the workspace out from under this one), so it is not this job's
      // failure to report. Recording it would burn an attempt that the new owner
      // is already spending.
      logger.warn("job threw after lease loss; not recording failure", {
        jobId: job.id,
        err: serializeError(error),
      });
      return { kind: "lease-lost" };
    }
    if (ctx.cancelled()) {
      // Aborting mid-work throws in most shapes of handler. That is the expected
      // path for cancellation, not a failure to retry.
      logger.info("job cancelled mid-run", { jobId: job.id });
      return { kind: "cancelled" };
    }

    // `serializeError` returns a bare string for anything that is not an Error,
    // and handlers can throw non-Errors (a rejected promise carrying a string, a
    // library that throws an object). Reading `.message` off that union would
    // have written `undefined` into the job's error column for exactly the
    // hardest failures to diagnose. Caught by the compiler, not by a test.
    const serialized = serializeError(error);
    const reason = typeof serialized === "string" ? serialized : serialized.message;
    const { willRetry } = queue.fail(job.id, job.workerId, reason);
    logger.error("job failed", {
      jobId: job.id,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      willRetry,
      err: serialized,
    });
    return { kind: "failed", error, willRetry };
  } finally {
    scheduler.clearInterval(heartbeat);
  }
}
