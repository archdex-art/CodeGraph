import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-enqueue-"));
process.env["CG_DATA_DIR"] = dataDir;
process.env["CG_USE_WORKER"] = "true";

const { db, findQueuedJob, findLiveJobForRepo } = await import("@codegraph/persistence");
const { createIndexJob } = await import("@/lib/store");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
  db().exec("DELETE FROM jobs");
  db().exec("DELETE FROM repos");
});

/**
 * The enqueue path and the per-repo mutex (PLAN.md §3).
 *
 * `CG_USE_WORKER=true` is set above because the default is false — the inline path is
 * still the shipped default until the worker is deployable. These tests cover the
 * branch that P2's cutover commit will make the default.
 */
describe("createIndexJob with the worker enabled", () => {
  it("writes a queued job instead of running the analysis inline", () => {
    const result = createIndexJob("/tmp/example", "local", undefined, null);
    expect(result.ok).toBe(true);

    const job = findQueuedJob(result.jobId)!;
    expect(job.status).toBe("queued");
    expect(job.kind).toBe("analyze");
    // The worker needs everything to run the job without consulting the web process.
    expect(JSON.parse(job.payload_json)).toMatchObject({
      repoId: result.repoId,
      source: "/tmp/example",
      sourceType: "local",
    });
  });

  it("keeps a session token out of the payload when there is none", () => {
    const result = createIndexJob("/tmp/example", "local", undefined, null);
    expect(JSON.parse(findQueuedJob(result.jobId)!.payload_json)).not.toHaveProperty("githubToken");
  });

  it("refuses a second run for a repo already being analysed, returning the live job", () => {
    // Two concurrent runs clone into the same workspace directory and race on every
    // file in it. The caller gets the in-flight job's id so it can attach to that
    // progress stream rather than render an error.
    const first = createIndexJob("https://github.com/o/r", "git", undefined, null);
    expect(first.ok).toBe(true);

    // Same repo URL, but a fresh repoId — the mutex is keyed on the repo row, so this
    // only collides once the first job is live.
    const live = findLiveJobForRepo(first.repoId);
    expect(live?.id).toBe(first.jobId);
  });

  it("allows a new run once the previous job reached a terminal state", () => {
    const first = createIndexJob("/tmp/a", "local", undefined, null);
    db().prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(first.jobId);
    expect(findLiveJobForRepo(first.repoId)).toBeNull();
  });
});
