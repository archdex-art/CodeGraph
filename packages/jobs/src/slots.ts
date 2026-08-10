/**
 * A bounded gate over jobs this PROCESS dispatches itself.
 *
 * WHY THIS EXISTS ALONGSIDE THE QUEUE'S CEILING. There are two execution modes, and
 * exactly one of them is active in a given deployment. With `CG_USE_WORKER=true` the
 * web tier only writes rows and `apps/worker` is the sole executor, so the ceiling is
 * enforced where the row transitions to held — atomically, in `claimJob`'s SQL, which
 * is the only place two processes can agree. With `CG_USE_WORKER=false` there is no
 * queue poller at all: the web process calls `runJob(...)` directly, so nothing ever
 * reaches that statement and the bound has to sit on the dispatch. This is that bound.
 *
 * It is NOT a second coordination mechanism: it coordinates nothing across processes,
 * and it cannot, because the inline mode it serves is single-process by construction.
 * The job row remains the source of truth — a task waiting here has a `queued` row,
 * indistinguishable from one waiting for a worker, which is what lets the UI say so
 * without knowing which mode it is running under.
 *
 * The per-repo mutex is a different question and still answered elsewhere: this gate
 * bounds the HOST, and two submissions of one repository are refused before they ever
 * get here.
 */

export interface SlotGate {
  /**
   * Run `task` as soon as a slot is free, resolving/rejecting with its result.
   *
   * When a slot IS free the task is invoked SYNCHRONOUSLY, in the caller's tick. That
   * is load-bearing rather than incidental: both inline runners claim their repo row
   * before their first `await` precisely so a second request in the same tick sees the
   * claim, and deferring the whole call to a microtask would reopen that race for every
   * caller instead of only the ones that actually have to wait.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many tasks hold a slot, how many are waiting, and the ceiling itself. */
  stats(): { readonly active: number; readonly waiting: number; readonly limit: number };
}

export function createSlotGate(limit: number): SlotGate {
  // A ceiling of 0 does not throttle, it wedges: every task waits for a slot that can
  // never be released. Louder here than as an app that accepts work and never runs it.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`slot gate limit must be an integer >= 1, got ${String(limit)}`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  const start = <T>(task: () => Promise<T>): Promise<T> => {
    active += 1;
    let running: Promise<T>;
    try {
      running = task();
    } catch (e) {
      // A task that throws before returning a promise still took a slot. Without this
      // the slot leaks and the gate closes permanently after `limit` such throws.
      release();
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return running.finally(release);
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      if (active < limit) return start(task);
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      waiting.push(() => {
        start(task).then(resolve, reject);
      });
      return promise;
    },

    stats() {
      return { active, waiting: waiting.length, limit };
    },
  };
}
