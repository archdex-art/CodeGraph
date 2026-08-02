import type { Migration } from "../migration-type";
import type { SqliteDatabase } from "../sqlite";

/**
 * `jobs` becomes a real queue (LLD §8.1, §8.3; HLD §17 P2).
 *
 * v1's table is `(id, repo_id, status, progress, message, error)` — enough to
 * report on work the web process was already doing inline, and nothing more. It
 * cannot express the four things a worker needs:
 *
 *   · **what** the job is        → `kind` + `payload_json`
 *   · **who holds it**           → `worker_id` + `lease_until`
 *   · **how often it has tried** → `attempts` + `max_attempts`
 *   · **whether it is a repeat** → `idempotency_key`
 *
 * Without a lease, a worker crash strands the row in `running` forever; the
 * claim query in §8.3 reclaims it instead, which is what makes crashes
 * recoverable without a separate reaper process.
 *
 * ADDITIVE ONLY. The columns v1 writes (`status`, `progress`, `message`,
 * `error`) keep their names and meaning, so the fire-and-forget path in
 * `apps/web/src/lib/store.ts` continues to work unchanged while the worker is
 * introduced beside it. A migration that renamed `message` to `stage` would
 * have broken every in-flight job on the deploy that applied it.
 */

const JOBS_ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  // analyze | fix | timeline. Defaulted rather than NOT NULL without a default:
  // rows already in the table were all analysis jobs, and SQLite cannot add a
  // NOT NULL column to a populated table without one.
  ["kind", "TEXT NOT NULL DEFAULT 'analyze'"],
  // The handler's input. '{}' rather than NULL so a handler can parse
  // unconditionally instead of branching on absence.
  ["payload_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["priority", "INTEGER NOT NULL DEFAULT 0"],
  ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
  // Epoch ms. NULL = unclaimed. Compared against `Date.now()` by the claim
  // query, so an expired lease is indistinguishable from never-claimed —
  // deliberately, because both mean "available".
  ["lease_until", "INTEGER"],
  ["worker_id", "TEXT"],
  // The coarse pipeline phase (`cloning`, `indexing`, `scoring`). Distinct from
  // `message`, which is human-facing prose; `stage` is what metrics and the SSE
  // stream key on, so it must not carry a sentence.
  ["stage", "TEXT"],
  ["error", "TEXT"],
  ["idempotency_key", "TEXT"],
  ["created_at", "INTEGER NOT NULL DEFAULT 0"],
  ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
];

function columnNames(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export const migration004: Migration = {
  version: 4,
  name: "jobs_queue",
  up(db) {
    // The table exists from 001 on every database that has ever booted, but a
    // brand-new file runs the whole list in order, so this must not assume it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        message TEXT DEFAULT '',
        error TEXT
      );
    `);

    const existing = columnNames(db, "jobs");
    for (const [name, definition] of JOBS_ADDED_COLUMNS) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      }
    }

    // Rows that predate this migration have created_at/updated_at = 0 from the
    // column default. Left at 0 rather than back-filled to `Date.now()`: their
    // real creation time is unknown, and 0 is honest and sorts them oldest-first
    // in the claim query, which is where a stale queued row belongs anyway.

    // Supports the claim query's `ORDER BY priority DESC, created_at ASC` after
    // filtering on status, so claiming stays an index seek rather than a scan of
    // every terminal job ever run.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, created_at)`);

    // Partial, so the unlimited number of jobs WITHOUT an idempotency key do not
    // collide with each other on NULL. This is what makes "enqueue is safe to
    // retry" true at the database level instead of by convention.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL`
    );

    // Lets the SSE endpoint and the per-repo mutex find a repo's live jobs
    // without scanning. Not in LLD §8.1's index list, which specifies only the
    // claim and idempotency indexes; added because §8.1's own `repo_id` column
    // plus P2's per-repo mutex make "the live jobs for this repo" a hot query,
    // and without it that check scans the table on every enqueue.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_repo_status ON jobs(repo_id, status)`);
  },
};
