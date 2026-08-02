import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@codegraph/observability";
import { runJob } from "../src/index";
import type { ClaimedJob, JobQueue, Scheduler, Timer } from "../src/index";

/**
 * The runner's decisions under lease loss, cancellation, and failure.
 *
 * Driven through a fake queue on purpose. These are decisions the runner makes,
 * not properties of SQLite — provoking a real split-brain would mean rewriting
 * `lease_until` behind a live worker's back, which would test my ability to
 * manipulate timestamps rather than the runner's behaviour. The SQL those
 * decisions land on is tested against a real database file in
 * `packages/persistence/tests/jobs-queue.test.ts`.
 */

// Silenced via `sink`, not a log level: there is no "silent" level, and swallowing
// output at the sink keeps the real formatting path exercised.
const silentLogger = createLogger({ sink: () => {} });

/** Runs every scheduled callback synchronously on demand, so no test waits on wall time. */
function manualScheduler(): Scheduler & { tick(): void; cleared: boolean } {
  const callbacks: Array<() => void> = [];
  return {
    cleared: false,
    setInterval(fn: () => void): Timer {
      callbacks.push(fn);
      return callbacks.length as unknown as Timer;
    },
    clearInterval(): void {
      this.cleared = true;
    },
    tick(): void {
      for (const fn of [...callbacks]) fn();
    },
  };
}

interface FakeQueueOptions {
  readonly heartbeatHeld?: boolean;
  readonly progressHeld?: boolean;
  readonly cancelled?: boolean;
  readonly willRetry?: boolean;
}

function fakeQueue(options: FakeQueueOptions = {}) {
  const calls = {
    succeed: [] as string[],
    fail: [] as Array<{ id: string; error: string }>,
    progress: [] as Array<{ percent: number; stage: string }>,
    heartbeats: 0,
  };
  const queue: JobQueue = {
    enqueue: () => ({ ok: true, jobId: "unused", deduplicated: false }),
    claim: () => null,
    heartbeat: () => {
      calls.heartbeats += 1;
      return options.heartbeatHeld ?? true;
    },
    progress: (_id, _worker, percent, stage) => {
      calls.progress.push({ percent, stage });
      return options.progressHeld ?? true;
    },
    succeed: (id) => {
      calls.succeed.push(id);
    },
    fail: (id, _worker, error) => {
      calls.fail.push({ id, error });
      return { willRetry: options.willRetry ?? false };
    },
    cancel: () => true,
    isCancelled: () => options.cancelled ?? false,
    liveJobForRepo: () => null,
  };
  return { queue, calls };
}

const job: ClaimedJob = {
  id: "job-1",
  repoId: "repo-1",
  kind: "analyze",
  payload: { repoId: "repo-1" },
  attempts: 1,
  maxAttempts: 3,
  workerId: "worker-a",
};

function options(queue: JobQueue, scheduler: Scheduler) {
  return { queue, logger: silentLogger, leaseMs: 30_000, scheduler };
}

describe("runJob — success", () => {
  it("marks the job succeeded and stops the heartbeat", async () => {
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue();

    const outcome = await runJob(job, async () => {}, options(queue, scheduler));

    expect(outcome.kind).toBe("succeeded");
    expect(calls.succeed).toEqual(["job-1"]);
    // A leaked interval keeps the process alive and keeps renewing a lease on a
    // job nobody is running.
    expect(scheduler.cleared).toBe(true);
  });

  it("passes the payload through to the handler", async () => {
    const scheduler = manualScheduler();
    const { queue } = fakeQueue();
    const handler = vi.fn(async () => {});

    await runJob(job, handler, options(queue, scheduler));

    expect(handler).toHaveBeenCalledWith({ repoId: "repo-1" }, expect.anything());
  });
});

describe("runJob — failure", () => {
  it("records the failure and reports whether it will retry", async () => {
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue({ willRetry: true });

    const outcome = await runJob(
      job,
      async () => {
        throw new Error("clone failed");
      },
      options(queue, scheduler)
    );

    expect(outcome).toMatchObject({ kind: "failed", willRetry: true });
    expect(calls.fail).toEqual([{ id: "job-1", error: "clone failed" }]);
  });

  it("records a readable reason when a handler throws a bare string", () => {
    // Handlers can throw non-Errors: a rejected promise carrying a string, or a
    // library that throws a plain object. `serializeError` returns a bare string
    // for those, so reading `.message` off it wrote `undefined` into the error
    // column — for exactly the failures that are hardest to diagnose. The
    // compiler caught this; no test had.
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue();

    return runJob(
      job,
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "git exited with code 128";
      },
      options(queue, scheduler)
    ).then((outcome) => {
      expect(outcome.kind).toBe("failed");
      expect(calls.fail).toEqual([{ id: "job-1", error: "git exited with code 128" }]);
    });
  });

  it("records a readable reason when a handler throws a non-Error object", async () => {
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue();

    await runJob(
      job,
      async () => {
        throw { code: "ENOENT" };
      },
      options(queue, scheduler)
    );

    // String(...) of an object, but never `undefined` — the column always says
    // something a human can act on.
    expect(calls.fail[0]?.error).toBeTruthy();
    expect(calls.fail[0]?.error).not.toBe("undefined");
  });

  it("never throws, so one bad repository cannot kill the poll loop", async () => {
    // The whole point of the separate process is that a crash is contained. If the
    // runner rethrew, a bad repo would take the worker down and stop the queue —
    // relocating the failure rather than removing it.
    const scheduler = manualScheduler();
    const { queue } = fakeQueue();

    await expect(
      runJob(
        job,
        async () => {
          throw new Error("boom");
        },
        options(queue, scheduler)
      )
    ).resolves.toMatchObject({ kind: "failed" });
    expect(scheduler.cleared).toBe(true);
  });

  it("stops the heartbeat even when the handler throws", async () => {
    const scheduler = manualScheduler();
    const { queue } = fakeQueue();

    await runJob(
      job,
      async () => {
        throw new Error("boom");
      },
      options(queue, scheduler)
    );

    expect(scheduler.cleared).toBe(true);
  });
});

describe("runJob — lease loss", () => {
  it("abandons without writing a terminal state when the heartbeat loses the lease", async () => {
    // The split-brain case. Another worker now owns this job; writing succeeded or
    // failed here would overwrite the real owner's result.
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue({ heartbeatHeld: false });

    const outcome = await runJob(
      job,
      async () => {
        scheduler.tick(); // the heartbeat fires and discovers the lease is gone
      },
      options(queue, scheduler)
    );

    expect(outcome.kind).toBe("lease-lost");
    expect(calls.succeed).toEqual([]);
    expect(calls.fail).toEqual([]);
  });

  it("tells the handler to stop via progress() returning false", async () => {
    const scheduler = manualScheduler();
    const { queue } = fakeQueue({ progressHeld: false });
    let stillHeld: boolean | undefined;

    await runJob(
      job,
      async (_payload, ctx) => {
        stillHeld = ctx.progress(50, "indexing", "half way");
      },
      options(queue, scheduler)
    );

    expect(stillHeld).toBe(false);
  });

  it("does not record a failure for a throw that follows lease loss", async () => {
    // The throw is very likely a consequence of the takeover — the new owner moved
    // the workspace. Recording it would burn an attempt the new owner is spending.
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue({ heartbeatHeld: false });

    const outcome = await runJob(
      job,
      async () => {
        scheduler.tick();
        throw new Error("workspace vanished");
      },
      options(queue, scheduler)
    );

    expect(outcome.kind).toBe("lease-lost");
    expect(calls.fail).toEqual([]);
  });
});

describe("runJob — cancellation", () => {
  it("reports cancelled without overwriting the terminal status", async () => {
    // cancelJob already set `cancelled`. Writing `succeeded` here would replace the
    // user's cancellation with a lie.
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue({ cancelled: true });

    const outcome = await runJob(job, async () => {}, options(queue, scheduler));

    expect(outcome.kind).toBe("cancelled");
    expect(calls.succeed).toEqual([]);
    expect(calls.fail).toEqual([]);
  });

  it("treats a throw during cancellation as cancelled, not as a failure to retry", async () => {
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue({ cancelled: true });

    const outcome = await runJob(
      job,
      async () => {
        throw new Error("aborted");
      },
      options(queue, scheduler)
    );

    expect(outcome.kind).toBe("cancelled");
    expect(calls.fail).toEqual([]);
  });

  it("exposes cancellation to the handler so it can stop at a checkpoint", async () => {
    const scheduler = manualScheduler();
    const { queue } = fakeQueue({ cancelled: true });
    let observed: boolean | undefined;

    await runJob(
      job,
      async (_payload, ctx) => {
        observed = ctx.cancelled();
      },
      options(queue, scheduler)
    );

    expect(observed).toBe(true);
  });

  it("prefers lease-lost over cancelled when both are true", async () => {
    // A worker that no longer owns the job must not write ANY terminal state, even
    // one that happens to be correct — the new owner is authoritative.
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue({ heartbeatHeld: false, cancelled: true });

    const outcome = await runJob(
      job,
      async () => {
        scheduler.tick();
      },
      options(queue, scheduler)
    );

    expect(outcome.kind).toBe("lease-lost");
    expect(calls.succeed).toEqual([]);
    expect(calls.fail).toEqual([]);
  });
});

describe("runJob — progress reporting", () => {
  it("forwards stage and percent to the queue", async () => {
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue();

    await runJob(
      job,
      async (_payload, ctx) => {
        ctx.progress(30, "cloning", "Cloning repository…");
        ctx.progress(70, "indexing", "Building knowledge graph…");
      },
      options(queue, scheduler)
    );

    expect(calls.progress).toEqual([
      { percent: 30, stage: "cloning" },
      { percent: 70, stage: "indexing" },
    ]);
  });

  it("renews the lease on each heartbeat tick", async () => {
    const scheduler = manualScheduler();
    const { queue, calls } = fakeQueue();

    await runJob(
      job,
      async () => {
        scheduler.tick();
        scheduler.tick();
      },
      options(queue, scheduler)
    );

    expect(calls.heartbeats).toBe(2);
  });
});
