/**
 * `PipelineContext` — what a pipeline stage is given besides its input (HLD §8).
 *
 * HLD specifies this carrying the logger, the cancellation signal, the clock, the
 * cache handle, and a `budget` (time + memory). Only `signal` exists today, and the
 * omissions are phase boundaries rather than oversights:
 *
 *   · `cache`  → P6 (content-addressed per-file cache). There is nothing to hand a
 *                stage until that store exists.
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
