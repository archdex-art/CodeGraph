import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REINDEX_QUIET_MS, scheduleReindex } from "@/lib/store";

/**
 * The coalescing contract of `scheduleReindex` (AUDIT_2026-07-12 F098).
 *
 * The runner is INJECTED. The production default starts a real pipeline run — a
 * workspace, Tree-sitter and SQLite — and none of that is what these tests are about:
 * the property that makes edit-triggered re-indexing shippable is purely about
 * COUNTING. The editor autosaves roughly once per second and a full index is seconds of
 * parsing, so a scheduler that runs once per save turns typing into a permanent CPU
 * storm on a 0.5 vCPU container. What has to hold is that a burst collapses to one run,
 * that a burst DURING a run collapses to one more, and that a failure leaves nothing
 * wedged.
 *
 * Repo ids are unique per test because the scheduler's state is a module-level Map that
 * outlives a test — which is also the state a leak would show up in.
 */
let seq = 0;
const freshRepoId = (): string => `repo-${++seq}`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleReindex", () => {
  it("collapses a burst inside the quiet period into exactly one run", async () => {
    const repoId = freshRepoId();
    const run = vi.fn(async () => ({ deferred: false }));

    // Ten autosaves, each a little under a second apart: the shape of someone typing.
    for (let i = 0; i < 10; i++) {
      scheduleReindex(repoId, run);
      await vi.advanceTimersByTimeAsync(900);
    }
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(repoId);
  });

  it("does not run until the workspace has been quiet for the full period", async () => {
    const repoId = freshRepoId();
    const run = vi.fn(async () => ({ deferred: false }));

    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS - 1);
    expect(run).not.toHaveBeenCalled();

    // One more save restarts the clock rather than letting the pending one through.
    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS - 1);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("turns N triggers arriving during a run into exactly one follow-up run", async () => {
    const repoId = freshRepoId();
    // Holds the first pass "in flight" for as long as the test wants, which is the only
    // way to observe the pending-flag branch deterministically.
    const inFlight = Promise.withResolvers<void>();
    const run = vi.fn(async () => {
      await inFlight.promise;
      return { deferred: false };
    });

    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // Five more saves while the first pass is still parsing. A queue here would mean five
    // more full index passes for edits the single follow-up pass already covers.
    for (let i = 0; i < 5; i++) scheduleReindex(repoId, run);
    expect(run).toHaveBeenCalledTimes(1);

    inFlight.resolve();
    // Drain microtasks: the scheduler re-arms in a `finally` after awaiting the runner,
    // so the follow-up timer does not exist yet and advancing the clock here would
    // observe the scheduler mid-transition.
    await Promise.resolve();
    await Promise.resolve();
    // The follow-up is a fresh quiet period, not an immediate re-run: the triggers that
    // set the pending flag were saves, and more are usually still coming.
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(2);

    // And it stops there — the pending flag is consumed, not a counter.
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS * 5);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("swallows a rejecting run and still serves the next trigger", async () => {
    const repoId = freshRepoId();
    const run = vi.fn(async (): Promise<{ deferred: boolean }> => {
      throw new Error("index blew up");
    });

    scheduleReindex(repoId, run);
    // The assertion is the absence of an unhandled rejection: `scheduleReindex` returns
    // void into a route handler that has already answered the client, so a rejection
    // escaping here takes the process down for work nobody is waiting on.
    await expect(vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS)).resolves.not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);

    // Not wedged: the failed run released the repo's slot, so the next save is scheduled
    // normally rather than being treated as "still running" forever.
    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("survives a runner that throws synchronously", async () => {
    const repoId = freshRepoId();
    const run = vi.fn((): Promise<{ deferred: boolean }> => {
      throw new Error("threw before returning a promise");
    });

    scheduleReindex(repoId, run);
    await expect(vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS)).resolves.not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);

    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("re-arms when a run is refused, instead of dropping the edit", async () => {
    // The `CG_USE_WORKER=true` path — the one the shipped image uses — can only report that
    // the job was ENQUEUED, so the next trigger arrives while the queue's per-repo mutex is
    // still held and the runner comes back "busy". Treating that as a completed pass loses
    // the user's most recent save with no trace: nothing else would ever re-trigger.
    const repoId = freshRepoId();
    let refusalsLeft = 2;
    const run = vi.fn(async () => ({ deferred: refusalsLeft-- > 0 }));

    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // Each refusal buys another quiet period, unprompted by any new save.
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(3);

    // The third call was not refused, so the chain stops rather than spinning forever.
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS * 5);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("gives up after a bounded number of refusals", async () => {
    // A repo wedged at status=indexing by a killed executor refuses forever. Retrying it
    // every 10s for the life of the process is a leak with a timer attached.
    const repoId = freshRepoId();
    const run = vi.fn(async () => ({ deferred: true }));

    scheduleReindex(repoId, run);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS * 20);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("debounces each repo independently", async () => {
    const a = freshRepoId();
    const b = freshRepoId();
    const runA = vi.fn(async () => ({ deferred: false }));
    const runB = vi.fn(async () => ({ deferred: false }));

    scheduleReindex(a, runA);
    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS / 2);
    scheduleReindex(b, runB);

    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS / 2);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REINDEX_QUIET_MS / 2);
    expect(runB).toHaveBeenCalledTimes(1);
  });
});
