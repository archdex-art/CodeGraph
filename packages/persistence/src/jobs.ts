import { db } from "./db";

/**
 * Index-job rows.
 *
 * A job is not tenant-scoped itself — it is scoped through the repo it belongs
 * to, which is why `findJob` returns the `repo_id` and the caller checks repo
 * visibility (F005). Duplicating the visibility predicate here would let the two
 * copies drift.
 */

export interface JobRow {
  readonly id: string;
  readonly repo_id: string;
  readonly status: string;
  readonly progress: number;
  readonly message: string;
  readonly error: string | null;
}

export function insertJob(id: string, repoId: string): void {
  db()
    .prepare("INSERT INTO jobs (id, repo_id, status, progress, message) VALUES (?, ?, 'queued', 0, 'Queued')")
    .run(id, repoId);
}

export function findJob(id: string): JobRow | null {
  const row = db()
    .prepare("SELECT id, repo_id, status, progress, message, error FROM jobs WHERE id = ?")
    .get(id) as JobRow | undefined;
  return row ?? null;
}

export function updateJob(
  id: string,
  status: string,
  progress: number,
  message: string,
  error?: string,
): void {
  db()
    .prepare("UPDATE jobs SET status=?, progress=?, message=?, error=? WHERE id=?")
    .run(status, progress, message, error ?? null, id);
}
