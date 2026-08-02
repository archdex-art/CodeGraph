import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-jobs-queue-"));
process.env["CG_DATA_DIR"] = dataDir;

const {
  claimJob,
  cancelJob,
  db,
  enqueueJob,
  failJob,
  findLiveJobForRepo,
  findQueuedJob,
  heartbeatJob,
  isJobCancelled,
  succeedJob,
  updateJobProgress,
} = await import("../src/index");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * The job queue (LLD §8.3), exercised against a real SQLite file rather than a
 * mock, because every property that matters here is a property of the SQL: the
 * claim is atomic because of how the `UPDATE ... WHERE id = (SELECT ...)` form
 * takes its write lock, and the retry decision is made against the row's own
 * `attempts`. A fake would assert my beliefs about SQLite instead of SQLite.
 */

beforeEach(() => {
  db().exec("DELETE FROM jobs");
});

function enqueue(id: string, repoId = "repo-1", extra: Record<string, unknown> = {}) {
  return enqueueJob({ id, repoId, kind: "analyze", payload: { repoId }, ...extra });
}

describe("enqueueJob", () => {
  it("stores kind and payload so a worker knows what to run", () => {
    enqueue("job-1");
    const job = findQueuedJob("job-1");
    expect(job?.kind).toBe("analyze");
    expect(JSON.parse(job!.payload_json)).toEqual({ repoId: "repo-1" });
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
  });

  it("deduplicates on idempotency key instead of enqueuing a second clone", () => {
    // A double-submitted form or a retried POST must not start two clones of the
    // same repository. This is the reason the key exists.
    const first = enqueue("job-1", "repo-1", { idempotencyKey: "repo-1:abc123" });
    const second = enqueue("job-2", "repo-1", { idempotencyKey: "repo-1:abc123" });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe("job-1");
    expect(findQueuedJob("job-2")).toBeNull();
  });

  it("does not deduplicate jobs that have no idempotency key", () => {
    // idx_jobs_idem is partial. Were it not, the second keyless insert would
    // collide with the first on NULL and the queue could hold exactly one
    // unkeyed job at a time.
    enqueue("job-1");
    enqueue("job-2");
    expect(findQueuedJob("job-1")).not.toBeNull();
    expect(findQueuedJob("job-2")).not.toBeNull();
  });
});

describe("claimJob", () => {
  it("hands the job to exactly one worker", () => {
    enqueue("job-1");
    const a = claimJob("worker-a", Date.now() + 30_000);
    const b = claimJob("worker-b", Date.now() + 30_000);

    expect(a?.id).toBe("job-1");
    expect(a?.worker_id).toBe("worker-a");
    expect(b).toBeNull();
  });

  it("increments attempts on claim, not on completion", () => {
    // A worker killed by the OOM reaper never reports anything. Counting
    // attempts at completion would let exactly the crash this architecture
    // exists to survive retry forever.
    enqueue("job-1");
    expect(claimJob("worker-a", Date.now() + 30_000)?.attempts).toBe(1);
  });

  it("orders by priority first, then oldest-first within a priority", () => {
    enqueue("low", "repo-1", { priority: 0 });
    enqueue("high", "repo-2", { priority: 5 });
    enqueue("also-high", "repo-3", { priority: 5 });

    expect(claimJob("w", Date.now() + 30_000)?.id).toBe("high");
    expect(claimJob("w", Date.now() + 30_000)?.id).toBe("also-high");
    expect(claimJob("w", Date.now() + 30_000)?.id).toBe("low");
  });

  it("reclaims a job whose lease expired, which is how worker crashes recover", () => {
    // The property the whole lease design exists for. A crashed worker leaves the
    // row leased; without reclaim it is stranded forever and needs a reaper.
    enqueue("job-1");
    const leaseAlreadyExpired = Date.now() - 1_000;
    claimJob("worker-that-dies", leaseAlreadyExpired);

    const reclaimed = claimJob("worker-b", Date.now() + 30_000);
    expect(reclaimed?.id).toBe("job-1");
    expect(reclaimed?.worker_id).toBe("worker-b");
    // Second claim, so the attempt budget is being consumed.
    expect(reclaimed?.attempts).toBe(2);
  });

  it("stops reclaiming an abandoned job once its attempt budget is spent", () => {
    // The crash path had no budget. A payload that kills its worker every time was
    // re-leased forever — `attempts` climbing past `max_attempts` without ever being
    // read, because only `failJob` (the *reported* path) enforces the budget, and a
    // worker that dies never reports. The job never went terminal, so nothing ever
    // surfaced it as failed and the crash loop was invisible.
    enqueue("poison", "repo-1", { maxAttempts: 2 });

    const expired = () => Date.now() - 1_000;
    expect(claimJob("w1", expired())?.attempts).toBe(1); // worker dies
    expect(claimJob("w2", expired())?.attempts).toBe(2); // budget now spent

    // Third poll: no third lease, and the row is terminal rather than stuck 'leased'.
    expect(claimJob("w3", Date.now() + 30_000)).toBeNull();
    const retired = findQueuedJob("poison");
    expect(retired?.status).toBe("failed");
    expect(retired?.attempts).toBe(2);
    expect(retired?.lease_until).toBeNull();
    expect(retired?.worker_id).toBeNull();
  });

  it("keeps draining healthy jobs while a poison job is retired", () => {
    // The queue-level consequence. The expired lease sorts ahead of a queued job, so
    // an unbudgeted poison job was handed out on every poll and everything behind it
    // starved.
    enqueue("poison", "repo-1", { maxAttempts: 1, priority: 5 });
    enqueue("healthy", "repo-2", { priority: 1 });

    expect(claimJob("w1", Date.now() - 1_000)?.id).toBe("poison"); // dies, budget spent
    expect(claimJob("w2", Date.now() + 30_000)?.id).toBe("healthy");
    expect(findQueuedJob("poison")?.status).toBe("failed");
  });

  it("does not reclaim a job whose lease is still valid", () => {
    enqueue("job-1");
    claimJob("worker-a", Date.now() + 30_000);
    expect(claimJob("worker-b", Date.now() + 30_000)).toBeNull();
  });

  it("never returns a terminal job", () => {
    enqueue("job-1");
    claimJob("worker-a", Date.now() + 30_000);
    succeedJob("job-1", "worker-a", "done");
    expect(claimJob("worker-b", Date.now() + 30_000)).toBeNull();
  });
});

describe("heartbeatJob and updateJobProgress", () => {
  it("extends the lease for the worker that holds it", () => {
    enqueue("job-1");
    claimJob("worker-a", Date.now() + 1_000);
    const extended = Date.now() + 60_000;

    expect(heartbeatJob("job-1", "worker-a", extended)).toBe(true);
    expect(findQueuedJob("job-1")!.lease_until).toBe(extended);
  });

  it("refuses a worker that no longer holds the lease", () => {
    // The split-brain case: worker-a stalled, its lease expired, worker-b took
    // over. If worker-a could heartbeat or report progress it would corrupt the
    // new owner's run. Returning false is the signal for it to abandon the job.
    enqueue("job-1");
    claimJob("worker-a", Date.now() - 1_000);
    claimJob("worker-b", Date.now() + 30_000);

    expect(heartbeatJob("job-1", "worker-a", Date.now() + 60_000)).toBe(false);
    expect(updateJobProgress("job-1", "worker-a", 90, "scoring", "…")).toBe(false);
    expect(findQueuedJob("job-1")!.worker_id).toBe("worker-b");
  });

  it("records stage and progress separately from the human message", () => {
    // `stage` is what metrics and SSE key on, so it must stay a bare token.
    enqueue("job-1");
    claimJob("worker-a", Date.now() + 30_000);
    updateJobProgress("job-1", "worker-a", 55, "indexing", "Building knowledge graph…");

    const job = findQueuedJob("job-1")!;
    expect(job.stage).toBe("indexing");
    expect(job.progress).toBe(55);
    expect(job.message).toBe("Building knowledge graph…");
    expect(job.status).toBe("running");
  });
});

describe("failJob", () => {
  it("requeues while attempts remain", () => {
    enqueue("job-1", "repo-1", { maxAttempts: 3 });
    claimJob("worker-a", Date.now() + 30_000);

    expect(failJob("job-1", "worker-a", "clone failed").willRetry).toBe(true);
    const job = findQueuedJob("job-1")!;
    expect(job.status).toBe("queued");
    // Lease released, so the next poll can pick it up immediately.
    expect(job.lease_until).toBeNull();
    expect(job.worker_id).toBeNull();
  });

  it("goes terminal once the attempt budget is spent", () => {
    enqueue("job-1", "repo-1", { maxAttempts: 1 });
    claimJob("worker-a", Date.now() + 30_000);

    expect(failJob("job-1", "worker-a", "clone failed").willRetry).toBe(false);
    expect(findQueuedJob("job-1")!.status).toBe("failed");
  });

  it("decides retry from the row's own attempts, not from the caller", () => {
    // maxAttempts 2: the first failure retries, the second is terminal. A worker
    // cannot talk the queue into granting a fresh budget by re-reporting.
    enqueue("job-1", "repo-1", { maxAttempts: 2 });
    claimJob("worker-a", Date.now() + 30_000);
    expect(failJob("job-1", "worker-a", "boom").willRetry).toBe(true);
    claimJob("worker-a", Date.now() + 30_000);
    expect(failJob("job-1", "worker-a", "boom").willRetry).toBe(false);
  });
});

describe("cancelJob", () => {
  it("cancels a queued job and keeps it from being claimed", () => {
    enqueue("job-1");
    expect(cancelJob("job-1")).toBe(true);
    expect(isJobCancelled("job-1")).toBe(true);
    expect(claimJob("worker-a", Date.now() + 30_000)).toBeNull();
  });

  it("cancels a running job so its worker sees it at the next checkpoint", () => {
    enqueue("job-1");
    claimJob("worker-a", Date.now() + 30_000);
    expect(cancelJob("job-1")).toBe(true);
    expect(isJobCancelled("job-1")).toBe(true);
  });

  it("refuses to rewrite a finished job into a cancellation", () => {
    enqueue("job-1");
    claimJob("worker-a", Date.now() + 30_000);
    succeedJob("job-1", "worker-a", "done");

    expect(cancelJob("job-1")).toBe(false);
    expect(findQueuedJob("job-1")!.status).toBe("succeeded");
  });
});

describe("findLiveJobForRepo — the per-repo mutex read half", () => {
  it("reports a live job so a second analysis is not started for the same repo", () => {
    // Two concurrent analyses clone into the same workspace directory and race on
    // every file in it.
    enqueue("job-1", "repo-1");
    expect(findLiveJobForRepo("repo-1")?.id).toBe("job-1");
  });

  it("reports nothing once the job reaches a terminal state", () => {
    enqueue("job-1", "repo-1");
    claimJob("worker-a", Date.now() + 30_000);
    succeedJob("job-1", "worker-a", "done");
    expect(findLiveJobForRepo("repo-1")).toBeNull();
  });

  it("does not confuse one repo's live job with another's", () => {
    enqueue("job-1", "repo-1");
    expect(findLiveJobForRepo("repo-2")).toBeNull();
  });
});
