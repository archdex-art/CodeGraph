/**
 * `PipelineContext` — what a pipeline stage is given besides its input (HLD §8).
 *
 * HLD specifies this carrying the logger, the cancellation signal, the clock, the
 * cache handle, and a `budget` (time + memory). Only `signal` exists today, and the
 * omissions are phase boundaries rather than oversights:
 *
 *   · `cache`  → SHIPPED. `IndexCacheStore` below is the seam; `@codegraph/analysis`
 *                owns the payload schema and every invalidation rule, and the store
 *                only moves opaque JSON. Injected rather than constructed because
 *                `analysis` sits above no I/O package (LLD §1.1) and must not learn
 *                where the bytes live.
 *   · `budget` → needs the degradation ladder (HLD §8.3) to have somewhere to record
 *                a partial result. Adding the field before stages can degrade would
 *                invite a stage to throw on budget instead, which HLD §8 explicitly
 *                forbids: "a stage that exceeds budget degrades — it does not throw".
 *   · `logger`/`clock` → stages take them directly today; routing them through here
 *                buys nothing until there is a second consumer.
 *
 * The type exists now, with one field, because it is the seam cancellation has to
 * travel along and every later phase widens it. Adding a parameter to every stage
 * signature later is the change this avoids.
 */
export interface PipelineContext {
  /**
   * Cancellation. Checked between files, never mid-file — there is no way to
   * interrupt a synchronous parse, so a stage bails at its next file boundary
   * (HLD §11: "every stage checks between files"). The worker's SIGTERM → SIGKILL
   * escalation is what bounds the latency when even that is too slow.
   */
  readonly signal?: AbortSignal;
  /**
   * Where a run reads the previous run's per-file work and writes its own.
   *
   * Absent means "index from scratch", which is always CORRECT and never wrong — every
   * reuse decision downstream is an optimisation guarded by a content hash. A store that
   * fails, is corrupt, or holds a payload from another engine version must behave exactly
   * like an absent one; that equivalence is what keeps a cache bug from becoming a wrong
   * answer.
   */
  readonly cache?: IndexCacheStore;
}

/**
 * Opaque persistence for the incremental index cache.
 *
 * Deliberately `unknown` in both directions. The store is implemented in `fsx` (the only
 * layer allowed raw `fs`, LLD §1.1) and would otherwise have to import the analysis types
 * it is forbidden to depend on. Validation of the payload belongs to the producer, which
 * is the only side that can tell a stale schema from a current one.
 *
 * Neither method may throw: a cache is an optimisation, and an optimisation that can fail a
 * run is a liability. Implementations swallow and log.
 */
export interface IndexCacheStore {
  /** Previous payload, or null when absent/unreadable/corrupt. */
  load(): unknown | null;
  /** Best-effort persist. Silent no-op on failure. */
  save(payload: unknown): void;
}

/** Throws if cancellation was requested. Called at stage yield points. */
export function throwIfAborted(ctx: PipelineContext | undefined): void {
  if (ctx?.signal?.aborted) {
    // `AbortError` name so a caller can distinguish "the user cancelled" from a real
    // failure without string-matching the message.
    const e = new Error("cancelled");
    e.name = "AbortError";
    throw e;
  }
}

/**
 * How many files a stage processes before yielding.
 *
 * Lives beside the cancellation contract because it is the same mechanism: a stage cannot be
 * interrupted mid-file, so the yield point IS the cancellation point (HLD §11). Splitting them
 * would let one be tuned without the other.
 */
export const YIELD_EVERY = 15;

/** Hand the event loop back, so an SSE heartbeat or an abort can be observed. */
export function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Wall-clock milliseconds per pipeline stage (HLD §14, "Run record").
 *
 * HLD promised that "every run persists its own stage timings and degradations". Degradations
 * shipped as `ScanCoverage`; the timings did not, and their absence is also why
 * `cg_stage_duration_seconds` did not exist - the metric and the run record are one piece of
 * work, not two.
 *
 * Returned on the result rather than pushed to a metrics store, because `analysis` sits below
 * `persistence` in the layering. The caller that already owns the run row records them.
 */
export type StageTimings = Record<string, number>;

/**
 * Time `fn`, recording the elapsed milliseconds under `stage`.
 *
 * Records on the way out whether or not `fn` threw. A stage that failed still consumed the
 * time, and losing it is how a slow stage that eventually errors becomes invisible - which is
 * exactly the run worth measuring.
 */
export async function timeStage<T>(
  into: StageTimings,
  stage: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    into[stage] = (into[stage] ?? 0) + (Date.now() - started);
  }
}
