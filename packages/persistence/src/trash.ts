import { db } from "./db";

/**
 * Soft-delete metadata rows.
 *
 * Rows only. Moving the actual files lives with the caller, because the trash
 * directory sits OUTSIDE the workspace root and so crosses `fsx`'s boundary.
 */

export interface TrashRow {
  readonly id: string;
  readonly repo_id: string;
  readonly orig_path: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly deleted_at: number;
}

export function insertTrashRow(row: TrashRow): void {
  db()
    .prepare(
      `INSERT INTO trash (id, repo_id, orig_path, name, type, size, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.repo_id, row.orig_path, row.name, row.type, row.size, row.deleted_at);
}

export function listTrashRows(repoId: string): TrashRow[] {
  return db()
    .prepare("SELECT * FROM trash WHERE repo_id = ? ORDER BY deleted_at DESC")
    .all(repoId) as TrashRow[];
}

export function findTrashRow(id: string, repoId: string): TrashRow | null {
  const row = db().prepare("SELECT * FROM trash WHERE id = ? AND repo_id = ?").get(id, repoId) as
    | TrashRow
    | undefined;
  return row ?? null;
}

/** Oldest-first ids beyond `cap`, so retention stays bounded without a sweeper. */
export function trashRowsBeyondCap(repoId: string, cap: number): string[] {
  const rows = db()
    .prepare("SELECT id FROM trash WHERE repo_id = ? ORDER BY deleted_at DESC LIMIT -1 OFFSET ?")
    .all(repoId, cap) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function deleteTrashRow(id: string): void {
  db().prepare("DELETE FROM trash WHERE id = ?").run(id);
}

export function deleteTrashRowsForRepo(repoId: string): void {
  db().prepare("DELETE FROM trash WHERE repo_id = ?").run(repoId);
}
