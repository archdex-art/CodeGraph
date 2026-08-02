import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@codegraph/observability";
import type { JobContext } from "@codegraph/jobs";
import { runInChild } from "../src/supervise";

/**
 * `runInChild` against REAL child processes.
 *
 * Spawning is the whole behaviour here — exit codes, signal deaths, stdout framing —
 * so a mocked `child_process` would assert my beliefs about spawn rather than spawn.
 * The children are tiny stub executors written per test, which keeps them real
 * without pulling the analysis pipeline into a unit test.
 */

const logger = createLogger({ sink: () => {} });
const dirs: string[] = [];

function stubExecutor(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-exec-"));
  dirs.push(dir);
  const file = path.join(dir, "stub.ts");
  writeFileSync(file, body);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<JobContext> = {}): JobContext & { reported: unknown[] } {
  const reported: unknown[] = [];
  return {
    jobId: "job-1",
    repoId: "repo-1",
    attempts: 1,
    progress: (percent, stage, message) => {
      reported.push({ percent, stage, message });
      return true;
    },
    cancelled: () => false,
    reported,
    ...overrides,
  } as JobContext & { reported: unknown[] };
}

describe("runInChild", () => {
  it("resolves when the executor exits 0", async () => {
    const c = ctx();
    await expect(
      runInChild("job-1", { any: "payload" }, c, logger, stubExecutor("process.exit(0);"))
    ).resolves.toBeUndefined();
  });

  it("delivers the payload on stdin, not argv", async () => {
    // argv is visible in `ps` to every user on the host, and a clone URL can carry a
    // token. This test is the reason the payload goes over a pipe.
    const c = ctx();
    const executor = stubExecutor(`
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        const { payload } = JSON.parse(raw);
        process.stdout.write(JSON.stringify({ percent: 50, stage: "echo", message: payload.source }) + "\\n");
        setTimeout(() => process.exit(0), 10);
      });
    `);
    await runInChild("job-1", { source: "https://example.test/r.git" }, c, logger, executor);
    expect(c.reported).toEqual([
      { percent: 50, stage: "echo", message: "https://example.test/r.git" },
    ]);
  });

  it("forwards progress split across chunk boundaries", async () => {
    // Chunk boundaries do not respect newlines. Parsing per-chunk drops these.
    const c = ctx();
    const executor = stubExecutor(`
      process.stdout.write('{"percent":10,"stage":"a","mess');
      setTimeout(() => {
        process.stdout.write('age":"first"}\\n{"percent":20,"stage":"b","message":"second"}\\n');
        setTimeout(() => process.exit(0), 20);
      }, 20);
    `);
    await runInChild("job-1", {}, c, logger, executor);
    expect(c.reported).toEqual([
      { percent: 10, stage: "a", message: "first" },
      { percent: 20, stage: "b", message: "second" },
    ]);
  });

  it("treats non-JSON stdout as log output, not a protocol error", async () => {
    // Dependencies print banners. One must not fail a job.
    const c = ctx();
    const executor = stubExecutor(`
      process.stdout.write("Debugger listening on ws://127.0.0.1:9229\\n");
      process.stdout.write('{"percent":99,"stage":"ok","message":"real"}\\n');
      setTimeout(() => process.exit(0), 20);
    `);
    await runInChild("job-1", {}, c, logger, executor);
    expect(c.reported).toEqual([{ percent: 99, stage: "ok", message: "real" }]);
  });

  it("rejects with the stderr tail when the executor exits non-zero", async () => {
    const c = ctx();
    const executor = stubExecutor(`
      process.stderr.write("clone failed: repository not found\\n");
      process.exit(1);
    `);
    await expect(runInChild("job-1", {}, c, logger, executor)).rejects.toThrow(
      /exited 1.*repository not found/s
    );
  });

  it("names the signal, and flags an unexplained SIGKILL as a likely OOM kill", async () => {
    // On a 512 MB host this is the likeliest failure of all, and "exit code null" in
    // the job ledger would tell an operator nothing.
    const c = ctx();
    const executor = stubExecutor(`process.kill(process.pid, "SIGKILL");`);
    await expect(runInChild("job-1", {}, c, logger, executor)).rejects.toThrow(
      /terminated by SIGKILL.*OOM killer/s
    );
  });

  it("SIGTERMs the executor when the job is cancelled", async () => {
    const c = ctx({ cancelled: () => true });
    // Would run for a minute if never signalled; the test's own timeout is the guard
    // against the cancellation path silently not working.
    const executor = stubExecutor(`
      process.on("SIGTERM", () => process.exit(2));
      setTimeout(() => process.exit(0), 60_000);
    `);
    await expect(runInChild("job-1", {}, c, logger, executor)).rejects.toThrow(/exited 2/);
  }, 20_000);

  it("SIGKILLs an executor that ignores SIGTERM", async () => {
    // Cancellation latency must be bounded even when the child refuses to unwind —
    // there is no way to interrupt a synchronous parse cooperatively.
    const c = ctx({ cancelled: () => true });
    const executor = stubExecutor(`
      process.on("SIGTERM", () => {});
      setTimeout(() => process.exit(0), 60_000);
    `);
    await expect(runInChild("job-1", {}, c, logger, executor)).rejects.toThrow(/SIGKILL/);
  }, 30_000);
});
