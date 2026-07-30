import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@codegraph/observability";

/**
 * The whole P2 mechanism end to end: a real SQLite queue, a real supervisor loop, and
 * a real child process per job.
 *
 * This is the test that would catch the failure the architecture exists to prevent —
 * a job that dies with its process leaving the queue consistent, and a worker that
 * survives it. Every layer here is the real one; the only stub is the executor body,
 * so the analysis pipeline is not dragged into an integration test about scheduling.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-worker-int-"));
process.env["CG_DATA_DIR"] = dataDir;
// Short lease and poll so the loop moves at test speed. The supervisor asserts
// lease > 3x poll at boot, and these satisfy it.
process.env["CG_WORKER_POLL_INTERVAL_MS"] = "50";
process.env["CG_WORKER_LEASE_MS"] = "5000";

const { db, enqueueJob, findQueuedJob } = await import("@codegraph/persistence");
const { createJobQueue } = await import("@codegraph/jobs");
const { runWorker } = await import("../src/main");

const logger = createLogger({ sink: () => {} });
const stubDirs: string[] = [];

function stubExecutor(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-exec-"));
  stubDirs.push(dir);
  const file = path.join(dir, "stub.ts");
  writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  db().exec("DELETE FROM jobs");
});

afterAll(() => {
  for (const dir of stubDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function enqueue(id: string, repoId = "repo-1"): void {
  enqueueJob({ id, repoId, kind: "analyze", payload: { repoId, source: "x", sourceType: "local" } });
}

describe("runWorker", () => {
  it("claims a queued job, runs it in a child, and marks it succeeded", async () => {
    enqueue("job-1");

    await runWorker({
      queue: createJobQueue(),
      logger,
      maxJobs: 1,
      executorPath: stubExecutor(`
        process.stdout.write('{"percent":55,"stage":"indexing","message":"working"}\\n');
        setTimeout(() => process.exit(0), 10);
      `),
    });

    const job = findQueuedJob("job-1")!;
    expect(job.status).toBe("succeeded");
    expect(job.progress).toBe(100);
    // Proof the child's progress reached the database through the supervisor rather
    // than the child writing job state itself.
    expect(job.stage).toBe("indexing");
  });

  it("requeues a job whose child dies, and keeps running", async () => {
    // The failure this architecture is built for: the executor is OOM-killed. The
    // supervisor must survive it, the job must go back on the queue, and the attempt
    // budget must be spent — not the worker.
    enqueue("job-1");

    await runWorker({
      queue: createJobQueue(),
      logger,
      maxJobs: 1,
      executorPath: stubExecutor(`process.kill(process.pid, "SIGKILL");`),
    });

    const job = findQueuedJob("job-1")!;
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.error).toMatch(/SIGKILL/);
    // Lease released, so the next poll can pick it up immediately.
    expect(job.lease_until).toBeNull();
  });

  it("stops retrying once the attempt budget is spent", async () => {
    enqueueJob({
      id: "job-1",
      repoId: "repo-1",
      kind: "analyze",
      payload: { repoId: "repo-1", source: "x", sourceType: "local" },
      maxAttempts: 2,
    });
    const failing = stubExecutor(`process.exit(1);`);

    await runWorker({ queue: createJobQueue(), logger, maxJobs: 2, executorPath: failing });

    const job = findQueuedJob("job-1")!;
    expect(job.attempts).toBe(2);
    expect(job.status).toBe("failed");
  });

  it("returns immediately when the queue is empty rather than spinning", async () => {
    // maxJobs 0 means "claim nothing", so this asserts the loop's exit condition is
    // checked before the poll sleep — a loop that slept first would hang the suite.
    await expect(
      runWorker({ queue: createJobQueue(), logger, maxJobs: 0 })
    ).resolves.toBeUndefined();
  });

  it("refuses to start when the lease is too short to survive its own heartbeat", async () => {
    // The heartbeat renews at a third of the lease. A lease under ~3 polls can expire
    // between beats, and another worker then reclaims a job that is running fine —
    // two workers writing one run. Misconfiguration must fail loudly at boot.
    //
    // The pair below is deliberately one the CONFIG VALIDATOR ACCEPTS: lease 5000 is
    // its minimum and poll 2000 is well inside range, so neither is individually
    // invalid — it is the ratio that is wrong, which no per-variable bound can see.
    // A first draft of this test used lease=100 and passed for the wrong reason:
    // `intVar("CG_WORKER_LEASE_MS", { min: 5000 })` rejected it first and the guard
    // never ran.
    const originalPoll = process.env["CG_WORKER_POLL_INTERVAL_MS"];
    process.env["CG_WORKER_POLL_INTERVAL_MS"] = "2000";
    try {
      await expect(runWorker({ queue: createJobQueue(), logger, maxJobs: 1 })).rejects.toThrow(
        /must exceed 3x/
      );
    } finally {
      process.env["CG_WORKER_POLL_INTERVAL_MS"] = originalPoll;
    }
  });

  it("quarantines a malformed payload instead of spending the retry budget", async () => {
    // PLAN.md §3's poison-pill quarantine. The executor exits 3 for a payload it cannot
    // parse, and retrying that is provably useless: the same bytes deserialise the same
    // way every time. Without this the queue would burn three attempts and three child
    // spawns to reach a conclusion available on the first.
    enqueueJob({
      id: "job-1",
      repoId: "repo-1",
      kind: "analyze",
      payload: { nonsense: true },
      maxAttempts: 3,
    });

    // The REAL executor, not a stub — the point is that its own payload validation
    // produces the quarantine exit code.
    await runWorker({ queue: createJobQueue(), logger, maxJobs: 1 });

    const job = findQueuedJob("job-1")!;
    expect(job.status).toBe("failed");
    // One attempt, not three: quarantine skipped the remaining budget.
    expect(job.attempts).toBe(1);
  }, 30_000);

  it("still retries a signal death, which quarantine must not swallow", async () => {
    // An OOM kill looks superficially like the case above and is the opposite: the
    // second attempt may not land beside whatever else was resident, so it often
    // succeeds. Quarantining it would turn transient memory pressure into permanent
    // failure.
    enqueue("job-2");

    await runWorker({
      queue: createJobQueue(),
      logger,
      maxJobs: 1,
      executorPath: stubExecutor(`process.kill(process.pid, "SIGKILL");`),
    });

    expect(findQueuedJob("job-2")!.status).toBe("queued");
  });

  it("quarantines a job after a SECOND signal death, per HLD §419", async () => {
    // One OOM kill is worth retrying: the next attempt may not land beside whatever
    // else was resident. Two is evidence the repository does not fit this host's
    // memory, and a third spawn only buys another OOM.
    enqueueJob({
      id: "job-oom",
      repoId: "repo-oom",
      kind: "analyze",
      payload: { repoId: "repo-oom", source: "x", sourceType: "local" },
      maxAttempts: 5,
    });
    const oom = stubExecutor(`process.kill(process.pid, "SIGKILL");`);

    // Two claims, so `attempts` reaches 2 on the second.
    await runWorker({ queue: createJobQueue(), logger, maxJobs: 2, executorPath: oom });

    const job = findQueuedJob("job-oom")!;
    expect(job.attempts).toBe(2);
    // Terminal despite a budget of 5 — the OOM rule, not the budget, stopped it.
    expect(job.status).toBe("failed");
  }, 30_000);

  it("still retries the FIRST signal death", async () => {
    enqueueJob({
      id: "job-oom1",
      repoId: "repo-oom1",
      kind: "analyze",
      payload: { repoId: "repo-oom1", source: "x", sourceType: "local" },
      maxAttempts: 5,
    });

    await runWorker({
      queue: createJobQueue(),
      logger,
      maxJobs: 1,
      executorPath: stubExecutor(`process.kill(process.pid, "SIGKILL");`),
    });

    const job = findQueuedJob("job-oom1")!;
    expect(job.attempts).toBe(1);
    expect(job.status).toBe("queued");
  });
});
