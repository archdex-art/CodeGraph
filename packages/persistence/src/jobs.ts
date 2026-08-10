import { db } from "./db";

/**
 * Job rows, and the queue operations over them (LLD §8.1, §8.3).
 *
 * A job is not tenant-scoped itself — it is scoped through the repo it belongs
 * to, which is why `findJob` returns the `repo_id` and the caller checks repo
 * visibility (F005). Duplicating the visibility predicate here would let the two
 * copies drift.
 *
 * The queue functions below are the SQL half of P2's worker. Policy (how long a
 * lease lasts, when to retry, how often to heartbeat) deliberately does NOT live
 * here — it is in `@codegraph/jobs`, because LLD §8 makes this module the only
 * one allowed to write SQL, not the place that decides scheduling behaviour.
 */

/** Terminal states. A job in one of these is never claimed again. */
export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export interface JobRow {
  readonly id: string;
  readonly repo_id: string;
  readonly status: string;
  readonly progress: number;
  readonly message: string;
  readonly error: string | null;
}

/** The full row, as the worker sees it. */
export interface QueuedJobRow extends JobRow {
  readonly kind: string;
  readonly payload_json: string;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly lease_until: number | null;
  readonly worker_id: string | null;
  readonly stage: string | null;
  /** Live pipeline phase as JSON, or null. See migration 006. */
  readonly phase_json: string | null;
  readonly idempotency_key: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface NewJob {
  readonly id: string;
  readonly repoId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly idempotencyKey?: string | null;
}

export function insertJob(id: string, repoId: string): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO jobs (id, repo_id, status, progress, message, kind, payload_json, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, 'Queued', 'analyze', '{}', ?, ?)`
    )
    .run(id, repoId, now, now);
}

/**
 * Jobs waiting to be claimed — `cg_queue_depth` (HLD §14).
 *
 * Counts `queued` only. A running job is not backlog: depth is meant to answer "is work piling
 * up faster than it is being done", and including in-flight work would make a healthy queue
 * with one busy worker look identical to a stalled one.
 */
export function queueDepth(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

export function findJob(id: string): JobRow | null {
  const row = db()
    .prepare("SELECT id, repo_id, status, progress, message, error FROM jobs WHERE id = ?")
    .get(id) as JobRow | undefined;
  return row ?? null;
}

/**
 * Coarse state write for the in-process path.
 *
 * Clears `phase_json`: this is only ever called when the job moves between the coarse
 * states, and the fine-grained phase belongs to the state being left. Leaving it would
 * park "detect · 462/462 files" underneath "Computing Health Score…", which is a line
 * that contradicts the one above it.
 */
export function updateJob(
  id: string,
  status: string,
  progress: number,
  message: string,
  error?: string,
): void {
  db()
    .prepare("UPDATE jobs SET status=?, progress=?, message=?, error=?, phase_json=NULL WHERE id=?")
    .run(status, progress, message, error ?? null, id);
}

/**
 * Live phase for a job the in-process path is running.
 *
 * Not worker-scoped, unlike `updateJobProgress`: there is no worker and no lease on this
 * path — the web process both owns and runs the job. Writes nothing but the phase, so it
 * cannot resurrect or contradict a terminal row's status.
 */
export function setJobPhase(id: string, phaseJson: string | null): void {
  db().prepare("UPDATE jobs SET phase_json=? WHERE id=?").run(phaseJson, id);
}

const QUEUED_JOB_COLUMNS = `id, repo_id, status, progress, message, error, kind, payload_json,
  priority, attempts, max_attempts, lease_until, worker_id, stage, phase_json, idempotency_key,
  created_at, updated_at`;

/**
 * Enqueue a job.
 *
 * Returns the existing job's id when `idempotencyKey` collides, rather than
 * throwing. That makes a double-submitted form or a retried POST a no-op instead
 * of a second clone of the same repository, which is the whole reason the key
 * exists. `idx_jobs_idem` is what enforces it — two concurrent requests race at
 * the database, not in application code, so exactly one wins.
 */
export function enqueueJob(job: NewJob): { id: string; deduplicated: boolean } {
  const now = Date.now();
  const key = job.idempotencyKey ?? null;

  if (key !== null) {
    const existing = db()
      .prepare("SELECT id FROM jobs WHERE idempotency_key = ?")
      .get(key) as { id: string } | undefined;
    if (existing) return { id: existing.id, deduplicated: true };
  }

  // `INSERT ... ON CONFLICT DO NOTHING` rather than a bare INSERT: the SELECT
  // above loses to a concurrent request that inserts between the read and the
  // write, and the loser then threw "UNIQUE constraint failed:
  // jobs.idempotency_key" out of the route — a 500 for exactly the
  // double-submitted POST the key exists to make harmless. Reproduced by racing
  // two processes on one CG_DATA_DIR. The conflict target is `idx_jobs_idem`'s,
  // so a duplicate `id` (a different bug) still throws.
  const inserted = db()
    .prepare(
      `INSERT INTO jobs
         (id, repo_id, status, progress, message, kind, payload_json,
          priority, attempts, max_attempts, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, 'Queued', ?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`
    )
    .run(
      job.id,
      job.repoId,
      job.kind,
      JSON.stringify(job.payload ?? {}),
      job.priority ?? 0,
      job.maxAttempts ?? 3,
      key,
      now,
      now
    );
  if (Number(inserted.changes) > 0) return { id: job.id, deduplicated: false };

  // Lost the race. Re-read to return the winner's id, which is what a caller
  // needs to attach to the in-flight job's progress stream.
  const winner = db()
    .prepare("SELECT id FROM jobs WHERE idempotency_key = ?")
    .get(key) as { id: string } | undefined;
  return winner ? { id: winner.id, deduplicated: true } : { id: job.id, deduplicated: false };
}

/**
 * Claim one job for `workerId`, holding it until `leaseUntil` (LLD §8.3).
 *
 * The `status IN ('leased','running') AND lease_until < now` arm is the whole
 * crash-recovery story: a worker that dies mid-job leaves its row held, and the
 * next poll reclaims it once the lease expires. That is why there is no reaper
 * process — expiry and claiming are the same statement, so they cannot disagree.
 *
 * `running` IS PART OF THAT ARM, and leaving it out was a total loss of crash
 * recovery rather than a corner case. Both this subquery and the retirement
 * UPDATE above it once matched `status='leased'` only, but `heartbeatJob` and
 * `updateJobProgress` promote the row to `running`: the heartbeat fires at
 * leaseMs/3 and the executor's first progress line lands about a second in, so
 * every job that got as far as doing work was `running` within seconds and
 * invisible to both arms from then on. A supervisor that died without a terminal
 * write — Render redeploy, SIGKILL past the drain window (`apps/worker/src/main.ts`
 * deliberately finishes the job in hand and can outlive the grace period), OOM
 * kill — left the row `running` with an expired lease FOREVER: never retried,
 * never failed. And because `findLiveJobForRepo` treats every non-terminal status
 * as live, `JobQueue.enqueue` then answered `repo-busy` for that repo forever, so
 * the repo could never be indexed again. The old tests missed it by never
 * heartbeating between the claim and the reclaim.
 *
 * `attempts` increments on claim, not on failure. A worker killed by the OOM
 * reaper never gets to report anything, so counting attempts at completion would
 * let exactly the crash this architecture exists to survive retry forever.
 *
 * Which is also why the expired-lease arm is BUDGETED. It used to reclaim
 * unconditionally, so a job that killed its worker every time — a poison payload,
 * a repository that OOMs the parser — was re-leased forever, `attempts` climbing
 * past `max_attempts` without ever being read. It never went terminal, and since
 * it sorts oldest-first it was handed out ahead of every other queued job, so the
 * queue stopped draining as well. `failJob` enforces the budget on the reported
 * path; nothing enforced it on the crash path.
 *
 * Atomic under WAL: the UPDATE ... WHERE id = (SELECT ... LIMIT 1) form means two
 * workers polling simultaneously cannot select the same row, because the write
 * lock is taken before the subquery's row is resolved.
 */
export function claimJob(
  workerId: string,
  leaseUntil: number,
  now: number = Date.now()
): QueuedJobRow | null {
  // Retire out-of-budget abandoned leases before claiming. A separate statement
  // rather than a transaction with the claim below: it is idempotent (a second
  // poller matches zero rows) and a crash between the two loses nothing, so the
  // only thing a transaction would add is a write lock held across both.
  db()
    .prepare(
      `UPDATE jobs
          SET status='failed', error=?, lease_until=NULL, worker_id=NULL, updated_at=?
        WHERE status IN ('leased','running') AND lease_until < ? AND attempts >= max_attempts`
    )
    .run("Abandoned: worker lease expired with no attempts remaining", now, now);

  const row = db()
    .prepare(
      `UPDATE jobs
          SET status='leased', worker_id=?, lease_until=?, attempts=attempts+1, updated_at=?
        WHERE id = (
          SELECT id FROM jobs
           WHERE (status='queued')
              OR (status IN ('leased','running') AND lease_until < ? AND attempts < max_attempts)
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
        )
        RETURNING ${QUEUED_JOB_COLUMNS}`
    )
    .get(workerId, leaseUntil, now, now) as QueuedJobRow | undefined;
  return row ?? null;
}

/**
 * Extend the lease on a job this worker still holds.
 *
 * Scoped to `worker_id` so a worker whose lease already expired and was
 * reclaimed by someone else cannot extend it back out from under the new owner.
 * Returns false in that case, which is the signal for the losing worker to
 * abandon the job rather than finish it and write a stale result.
 */
export function heartbeatJob(id: string, workerId: string, leaseUntil: number): boolean {
  const row = db()
    .prepare(
      `UPDATE jobs SET lease_until=?, status='running', updated_at=?
        WHERE id=? AND worker_id=? AND status IN ('leased','running')
        RETURNING id`
    )
    .get(leaseUntil, Date.now(), id, workerId) as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Report progress. Same worker-scoping rule as `heartbeatJob`.
 *
 * `phaseJson` is opaque here on purpose — this layer moves the bytes and the web tier
 * decides what they mean, exactly as `payload_json` already works. Passing `null` (which
 * every coarse stage report does) CLEARS the phase, so the fine-grained line never
 * outlives the stage that produced it.
 */
export function updateJobProgress(
  id: string,
  workerId: string,
  progress: number,
  stage: string,
  message: string,
  phaseJson: string | null = null
): boolean {
  const row = db()
    .prepare(
      `UPDATE jobs SET progress=?, stage=?, message=?, phase_json=?, status='running', updated_at=?
        WHERE id=? AND worker_id=? AND status IN ('leased','running')
        RETURNING id`
    )
    .get(progress, stage, message, phaseJson, Date.now(), id, workerId) as { id: string } | undefined;
  return row !== undefined;
}

/** Mark a held job succeeded, clearing the lease so nothing reclaims it. */
export function succeedJob(id: string, workerId: string, message: string): void {
  db()
    .prepare(
      `UPDATE jobs
          SET status='succeeded', progress=100, message=?, error=NULL,
              lease_until=NULL, phase_json=NULL, updated_at=?
        WHERE id=? AND worker_id=?`
    )
    .run(message, Date.now(), id, workerId);
}

/**
 * Fail a held job: back to `queued` while attempts remain, else terminal.
 *
 * The retry decision is made in SQL against the row's own `attempts`, not from a
 * value the caller passes in, so a worker that has lost its lease cannot talk the
 * queue into giving a job a fresh budget.
 */
export function failJob(
  id: string,
  workerId: string,
  error: string,
  permanent = false
): { willRetry: boolean } {
  // `permanent` skips the attempt budget entirely, for failures where retrying cannot
  // change the outcome — a malformed payload deserialises identically every time. The
  // budget still governs everything else, so this cannot be used to make ordinary
  // failures terminal by accident: the caller has to ask for it.
  const row = db()
    .prepare(
      `UPDATE jobs
          SET status = CASE WHEN ? THEN 'failed'
                            WHEN attempts < max_attempts THEN 'queued'
                            ELSE 'failed' END,
              error=?, lease_until=NULL, worker_id=NULL, updated_at=?
        WHERE id=? AND worker_id=?
        RETURNING status`
    )
    .get(permanent ? 1 : 0, error, Date.now(), id, workerId) as { status: string } | undefined;
  return { willRetry: row?.status === "queued" };
}

/**
 * Request cancellation.
 *
 * Terminal jobs are left alone — `AND status NOT IN (...)` — so cancelling an
 * already-succeeded job cannot rewrite history into a cancellation. A running
 * job's worker notices via `isJobCancelled` at its next checkpoint; there is no
 * way to interrupt a synchronous parse mid-file, and pretending otherwise would
 * be the dishonest version of this feature.
 */
export function cancelJob(id: string): boolean {
  const row = db()
    .prepare(
      `UPDATE jobs
          SET status='cancelled', message='Cancelled', lease_until=NULL, updated_at=?
        WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')
        RETURNING id`
    )
    .get(Date.now(), id) as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Fail every non-terminal job, and un-stick the repositories they hold.
 *
 * For the INLINE executor only, and correct only there — which is why the caller passes the
 * decision in rather than this module reading a flag. With `CG_USE_WORKER=false` the process
 * that dispatches a job is the process that runs it, so a non-terminal row at startup cannot
 * belong to anything still alive: whatever owned it is gone. With a worker, the identical row
 * is a job legitimately waiting to be claimed, and failing it here would delete queued work.
 *
 * The hole this closes is the inline twin of the expired-lease arm in `claimJob`, and it has
 * the same consequence, spelled out in that comment: `findLiveJobForRepo` treats every
 * non-terminal status as live, so `enqueue` answers `repo-busy` forever and the repository can
 * never be indexed again. A lease cannot close it — nothing renews one in inline mode — so the
 * boundary that does is process start.
 *
 * Observed on a dev server that had been left running: repo `archdex-art/CodeGraph` sat at
 * `indexing` for five hours behind a `queued` row from an executor that no longer existed,
 * with no way to recover it from the UI.
 *
 * FIVE terminal statuses, not three, because `jobs.status` carries TWO vocabularies. The queue
 * writes `queued|leased|running|succeeded|failed|cancelled` (`@codegraph/jobs`), while the
 * inline executor writes the web one — `queued|cloning|indexing|scoring|done|error` — through
 * `updateJob`. They overlap on `queued` and nowhere else, so a list that knows only the queue's
 * three terminal names treats every finished INLINE job as abandoned and rewrites its history.
 * Caught by running this against a real database: it restamped a five-hour-old `error` row.
 *
 */
export function abandonOrphanedJobs(): number {
  const now = Date.now();
  const rows = db()
    .prepare(
      `UPDATE jobs
          SET status='failed',
              error='Abandoned: the process running this job exited',
              message='Indexing failed',
              lease_until=NULL, worker_id=NULL, updated_at=?
        WHERE status NOT IN ('succeeded','failed','cancelled','done','error')
        RETURNING repo_id`
    )
    .all(now) as Array<{ repo_id: string }>;

  // The repo row carries its own status, and the UI reads THAT. Leaving it at `indexing`
  // would fix the queue and still show a spinner that never resolves.
  const repo = db().prepare(
    `UPDATE repos SET status='error', error='Indexing was interrupted — index again to retry'
      WHERE id=? AND status NOT IN ('done','error')`
  );
  for (const r of rows) repo.run(r.repo_id);

  return rows.length;
}

/** Cheap cancellation check for a worker's checkpoints. */
export function isJobCancelled(id: string): boolean {
  const row = db().prepare("SELECT status FROM jobs WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  return row?.status === "cancelled";
}

export function findQueuedJob(id: string): QueuedJobRow | null {
  const row = db()
    .prepare(`SELECT ${QUEUED_JOB_COLUMNS} FROM jobs WHERE id = ?`)
    .get(id) as QueuedJobRow | undefined;
  return row ?? null;
}

/**
 * The live (non-terminal) job for a repo, if any.
 *
 * This is the per-repo mutex's read half (HLD §17 P2). Two concurrent analyses of
 * one repository would clone into the same workspace directory and race on every
 * file in it, so the enqueue path consults this first. Uses
 * `idx_jobs_repo_status`.
 */
export function findLiveJobForRepo(repoId: string): QueuedJobRow | null {
  const row = db()
    .prepare(
      `SELECT ${QUEUED_JOB_COLUMNS} FROM jobs
        WHERE repo_id = ? AND status NOT IN ('succeeded','failed','cancelled')
        ORDER BY created_at ASC LIMIT 1`
    )
    .get(repoId) as QueuedJobRow | undefined;
  return row ?? null;
}
