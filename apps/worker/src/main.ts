import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { config } from "@codegraph/config";
import { createJobQueue, runJob, type JobQueue } from "@codegraph/jobs";
import { logger as baseLogger, serializeError, type Logger } from "@codegraph/observability";
import { setRepoError } from "@codegraph/persistence";
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
 *
 * The loop also owns releasing the REPO row on a terminal failure — see the comment at
 * the `setRepoError` call. That belongs here and not in `supervise.ts`, which is a pure
 * spawn-a-child-and-stream-its-stdout boundary with no queue or database access at all;
 * and not in `@codegraph/jobs`, which knows about jobs and has never known repos exist.
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

    // Release the repo row when the job is done for good. `handlers/analyze.ts` sets
    // `repos.status='indexing'` and clears it in its own catch — but the failures that
    // put us here are precisely the ones no catch ever runs for: the executor is
    // SIGKILLed by the OOM reaper or a redeploy, so the repo row stays frozen at
    // `indexing` with a NULL error. The job goes `failed` and is visibly failed, while
    // the repo looks like it is still working; the web app's BUSY_STATUSES check then
    // refuses every re-index of that repo forever, and nothing short of a manual DB
    // edit recovers it. There is no startup sweep, so this write is the only thing that
    // closes the gap.
    //
    // Only when the failure will NOT be retried. A job returning to `queued` is still
    // going to be indexed, and flipping the repo to `error` between attempts would show
    // the user a failure that the very next poll contradicts.
    if (outcome.kind === "failed" && !outcome.willRetry) {
      // Same derivation as the runner uses for the job's own `error` column, so the two
      // rows agree: `serializeError` returns a bare string for a non-Error throw, and
      // reading `.message` off that union would write `undefined` for exactly the
      // hardest failures to diagnose.
      const serialized = serializeError(outcome.error);
      const reason = typeof serialized === "string" ? serialized : serialized.message;
      setRepoError(job.repoId, "error", reason);
      log.warn("repo released after terminal job failure", { repoId: job.repoId, reason });
    }
  }

  log.info("worker exiting", { workerId: id, claimed });
}
