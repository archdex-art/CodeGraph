/**
 * Job vocabulary.
 *
 * LLD §1 lists `packages/jobs` and LLD §10's heading names it, but no subsection
 * specifies its interface — §10 details `fsx`, `vcs`, and `config` only. This
 * surface is therefore derived from what IS specified: the `kind` values and
 * column set in §8.1, the claim/lease semantics in §8.3, and the worker
 * responsibilities in HLD §5.1 ("lease · heartbeat · retry"). Where the docs are
 * silent the choice is noted rather than presented as settled.
 */

/** The `kind` column's domain (LLD §8.1: `analyze | fix | timeline`). */
export const JOB_KINDS = ["analyze", "fix", "timeline"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * The `status` column's domain (LLD §8.1:
 * `queued|leased|running|succeeded|failed|cancelled`).
 *
 * `leased` and `running` are distinct on purpose: `leased` means claimed but not
 * yet reporting, `running` means the handler has checked in at least once. The
 * gap between them is exactly where a worker that dies immediately after claiming
 * shows up, so collapsing them would hide that.
 */
export const JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A claimed job, as its handler sees it. */
export interface ClaimedJob<TPayload = unknown> {
  readonly id: string;
  readonly repoId: string;
  readonly kind: JobKind;
  readonly payload: TPayload;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** The worker holding the lease. Every write-back is scoped to it. */
  readonly workerId: string;
}

/**
 * What a handler may do to the job it is running.
 *
 * Deliberately narrow: a handler can report progress and ask whether it has been
 * cancelled, and that is all. It cannot succeed, fail, or extend its own lease —
 * those are the runner's decisions, made from whether the handler returned or
 * threw. A handler that could mark itself succeeded could also do so and then
 * throw, leaving the queue holding a lie.
 */
export interface JobContext {
  readonly jobId: string;
  readonly repoId: string;
  readonly attempts: number;
  /**
   * Report coarse progress. `stage` is a bare token (`cloning`, `indexing`,
   * `scoring`) that metrics and the SSE stream key on; `message` is the prose a
   * user reads. Keeping them separate is why the schema has both columns.
   *
   * Returns false when this worker no longer holds the lease, which means another
   * worker has taken the job over. A handler that sees false MUST stop: anything
   * it writes after that point races the new owner.
   */
  /**
   * `phaseJson` is the live sub-stage line (`{"stage":"detect","done":231,"total":462}`),
   * opaque to the queue and cleared by every report that omits it — the phase belongs to
   * the stage that produced it and must not outlive it.
   */
  progress(percent: number, stage: string, message: string, phaseJson?: string | null): boolean;
  /**
   * Whether cancellation has been requested.
   *
   * Cooperative by necessity. There is no way to interrupt a synchronous parse
   * mid-file, so a handler must call this at its own checkpoints; a job with no
   * checkpoints cannot be cancelled until it finishes its current step. That is a
   * real limitation and is stated in the route that offers cancellation.
   */
  cancelled(): boolean;
}

export type JobHandler<TPayload = unknown> = (
  payload: TPayload,
  ctx: JobContext
) => Promise<void>;

/** Why the runner stopped working on a job. Drives the queue write-back. */
export type JobOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "lease-lost" }
  | { readonly kind: "failed"; readonly error: unknown; readonly willRetry: boolean };
