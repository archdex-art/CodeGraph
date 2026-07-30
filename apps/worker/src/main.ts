import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { config } from "@codegraph/config";
import { createJobQueue, runJob, type JobQueue } from "@codegraph/jobs";
import { logger as baseLogger, type Logger } from "@codegraph/observability";
import { runInChild } from "./supervise";

/**
 * The worker supervisor (HLD ADR-001, PLAN.md §3).
 *
 * Claims a job, spawns an executor to run it, reports the outcome. It does not import
 * `@codegraph/analysis` and must never start doing so — the whole point of the split
 * is that the process holding the lease never loads a parser, so its memory does not
 * grow with the work. `depcruise` enforces that.
 *
 * Two failure modes, both covered without a reaper process:
 *   - the EXECUTOR dies   → non-zero exit seen immediately; the retry budget applies
 *   - the SUPERVISOR dies → its lease expires and the next poll reclaims (LLD §8.3)
 */

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  // NOT `.unref()`. When the queue is empty this timer is the only pending handle, so
  // unref'ing it lets the event loop drain and Node exits — the worker logged
  // "worker started" and then vanished, leaving jobs queued forever with nothing to
  // claim them. Found by the 512 MB container smoke test, which is the only check that
  // runs the worker as a long-lived process; every unit test bounds it with `maxJobs`
  // and so never waits on an idle poll.
  setTimeout(resolve, ms);
  return promise;
};

interface WorkerOptions {
  readonly queue?: JobQueue;
  readonly logger?: Logger;
  /** Stop after this many claimed jobs. Tests set it; unset means run forever. */
  readonly maxJobs?: number;
  readonly executorPath?: string;
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const queue = options.queue ?? createJobQueue();
  const log = options.logger ?? baseLogger;
  // Host and pid make a stranded lease traceable to a machine and process; the random
  // suffix keeps two workers distinct across a pid reuse.
  const id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const leaseMs = config.workerLeaseMs;
  const pollMs = config.workerPollIntervalMs;

  // Fail fast rather than silently stealing healthy jobs. The heartbeat renews at a
  // third of the lease, so a lease shorter than ~3 polls can expire between beats and
  // a live job gets reclaimed mid-run by another worker.
  if (leaseMs <= pollMs * 3) {
    throw new Error(
      `CG_WORKER_LEASE_MS (${leaseMs}) must exceed 3x CG_WORKER_POLL_INTERVAL_MS (${pollMs}); ` +
        `otherwise a healthy job loses its lease between heartbeats`
    );
  }

  let draining = false;
  const drain = (signal: string): void => {
    if (draining) return;
    draining = true;
    // Finish the job in hand, then exit. Killing it here would spend an attempt on
    // work that was progressing fine.
    log.info("draining: will exit after the current job", { workerId: id, signal });
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));

  log.info("worker started", { workerId: id, leaseMs, pollMs });

  let claimed = 0;
  while (!draining && (options.maxJobs === undefined || claimed < options.maxJobs)) {
    const job = queue.claim(id, leaseMs);
    if (!job) {
      await sleep(pollMs);
      continue;
    }
    claimed += 1;
    log.info("claimed job", {
      jobId: job.id,
      kind: job.kind,
      repoId: job.repoId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
    });

    // `runJob` owns the heartbeat, cancellation plumbing, and queue write-back, and
    // never throws. This handler is only "spawn the executor and wait".
    const outcome = await runJob(
      job,
      (payload, ctx) => runInChild(job.id, payload, ctx, log, options.executorPath),
      { queue, logger: log, leaseMs }
    );
    log.info("job finished", { jobId: job.id, outcome: outcome.kind });
  }

  log.info("worker exiting", { workerId: id, claimed });
}
