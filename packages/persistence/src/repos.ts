import type { ViewerId } from "@codegraph/core-domain";
import { db } from "./db";

/**
 * Repo reads and writes, with tenant isolation as a type-level obligation
 * (LLD §8).
 *
 * The model, unchanged from v1: a repo indexed while signed out has
 * `owner_id IS NULL` and lives in a shared public bucket that anyone may read
 * and mutate; a repo indexed while signed in is private to that account, and
 * every other viewer gets "not found" rather than "forbidden", so a private
 * repo's existence is not disclosed.
 *
 * What changes is WHERE that rule lives. v1 enforced it in `repoAccessDenied`,
 * called at the top of each route — correct today, and one new route away from a
 * leak. Here every scoped read takes a `ViewerId` and there is no overload
 * without one, so forgetting it does not compile.
 */

/** The visibility predicate, in one place. Public bucket OR owned by viewer. */
const VISIBLE = "(owner_id IS NULL OR owner_id = ?)";

/**
 * `ViewerId` is `number | null`; SQL needs a value that never equals a real
 * `owner_id`. User ids come from GitHub and are positive, so -1 can never
 * collide — and passing `null` would make `owner_id = ?` never match, silently
 * hiding the viewer's own repos.
 */
function bind(viewer: ViewerId): number {
  return viewer ?? -1;
}

export interface RepoRow {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly source_type: string;
  readonly status: string;
  readonly score: number | null;
  readonly loc: number | null;
  readonly error: string | null;
  readonly languages: string;
  readonly graph: string;
  readonly dimensions: string;
  readonly deps: string;
  readonly issues: string;
  readonly viz: string;
  readonly tree: string;
  readonly modules: string;
  readonly symbols: string;
  readonly churn_by_file: string;
  readonly owner_id: number | null;
  readonly created_at: number;
  readonly finished_at: number | null;
  readonly workspace_dir: string | null;
  readonly save_mode: string | null;
  readonly head_hash: string | null;
}

export interface RepoSummaryRow {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly source_type: string;
  readonly status: string;
  readonly score: number | null;
  readonly created_at: number;
  readonly finished_at: number | null;
}

export interface NewRepo {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly sourceType: string;
  readonly ownerId: number | null;
  readonly createdAt: number;
}

/**
 * Repos visible to `viewer`, newest first.
 *
 * The LIMIT 100 is carried over from v1 unchanged. It is a real cap, not
 * pagination — see REVIEW B7 for what `/api/fleet` does with it.
 */
export function listRepos(viewer: ViewerId): RepoSummaryRow[] {
  return db()
    .prepare(
      `SELECT id, url, name, source_type, status, score, created_at, finished_at
       FROM repos WHERE ${VISIBLE}
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all(bind(viewer)) as RepoSummaryRow[];
}

/**
 * One repo, or null if it does not exist OR is not visible to `viewer`.
 *
 * The two cases are deliberately indistinguishable to the caller: that is what
 * makes the route's 404 truthful without leaking existence.
 */
export function findRepo(id: string, viewer: ViewerId): RepoRow | null {
  const row = db()
    .prepare(`SELECT * FROM repos WHERE id = ? AND ${VISIBLE}`)
    .get(id, bind(viewer)) as RepoRow | undefined;
  return row ?? null;
}

/**
 * One repo with NO visibility filter.
 *
 * For the background job runner and the timeline engine, which act as the system
 * rather than on behalf of a viewer and must be able to write results back to a
 * private repo. Named separately, and deliberately awkwardly, so every unscoped
 * read is greppable and reviewable — the alternative, an optional viewer
 * argument, makes the unsafe case the easy one to reach by accident.
 */
export function findRepoUnscoped(id: string): RepoRow | null {
  const row = db().prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
  return row ?? null;
}

/**
 * The owning account, `null` for the public bucket, `undefined` if there is no
 * such repo.
 *
 * Lean by design — it avoids parsing the heavy JSON blobs `findRepo` returns —
 * and unscoped because it IS the ownership check that scoping is built from.
 */
export function repoOwnerId(id: string): number | null | undefined {
  const row = db().prepare("SELECT owner_id FROM repos WHERE id = ?").get(id) as
    | { owner_id: number | null }
    | undefined;
  return row ? row.owner_id : undefined;
}

export function insertRepo(repo: NewRepo): void {
  db()
    .prepare(
      `INSERT INTO repos (id, url, name, source_type, status, owner_id, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(repo.id, repo.url, repo.name, repo.sourceType, repo.ownerId, repo.createdAt);
}

export function setRepoStatus(id: string, status: string): void {
  db().prepare("UPDATE repos SET status = ? WHERE id = ?").run(status, id);
}

export function setRepoError(id: string, status: string, error: string): void {
  db().prepare("UPDATE repos SET status = ?, error = ? WHERE id = ?").run(status, error, id);
}

export function setRepoWorkspace(id: string, workspaceDir: string): void {
  db().prepare("UPDATE repos SET workspace_dir = ? WHERE id = ?").run(workspaceDir, id);
}

export function setRepoHeadHash(id: string, headHash: string | null): void {
  db().prepare("UPDATE repos SET head_hash = ? WHERE id = ?").run(headHash, id);
}

export function saveMode(id: string): string | null {
  const row = db().prepare("SELECT save_mode FROM repos WHERE id = ?").get(id) as
    | { save_mode: string | null }
    | undefined;
  return row?.save_mode ?? null;
}

export function setSaveMode(id: string, mode: string): void {
  db().prepare("UPDATE repos SET save_mode = ? WHERE id = ?").run(mode, id);
}

export interface WorkspaceLocation {
  readonly workspace_dir: string | null;
  readonly source_type: string;
}

/**
 * Where a repo's checkout lives, and whether we own it.
 *
 * Unscoped because the callers (route handlers that already ran their access
 * check, and the repo-delete path) need it to decide whether an on-disk
 * directory may be removed. `source_type` comes back with it because the answer
 * differs: a `git` workspace is ours to delete, a `local` one is the user's own
 * folder and must never be touched.
 */
export function repoWorkspace(id: string): WorkspaceLocation | null {
  const row = db().prepare("SELECT workspace_dir, source_type FROM repos WHERE id = ?").get(id) as
    | WorkspaceLocation
    | undefined;
  return row ?? null;
}

/** Fields written when indexing finishes. Every JSON blob is pre-serialised. */
export interface IndexedResultColumns {
  readonly score: number;
  readonly loc: number;
  readonly languages: string;
  readonly graph: string;
  readonly dimensions: string;
  readonly issues: string;
  readonly deps: string;
  readonly churnByFile: string;
  readonly viz: string;
  readonly tree: string;
  readonly modules: string;
  readonly symbols: string;
  /**
   * The on-disk checkout, kept as a persistent workspace for the editor. Git
   * clones are no longer deleted after indexing; local folders were never
   * copied in the first place.
   */
  readonly workspaceDir: string;
  readonly headHash: string | null;
  readonly finishedAt: number;
}

export function completeRepoIndex(id: string, cols: IndexedResultColumns): void {
  db()
    .prepare(
      `UPDATE repos SET status='done', score=?, loc=?, languages=?, graph=?, dimensions=?,
        issues=?, deps=?, churn_by_file=?, viz=?, tree=?, modules=?, symbols=?,
        workspace_dir=?, head_hash=?, finished_at=?
       WHERE id=?`,
    )
    .run(
      cols.score,
      cols.loc,
      cols.languages,
      cols.graph,
      cols.dimensions,
      cols.issues,
      cols.deps,
      cols.churnByFile,
      cols.viz,
      cols.tree,
      cols.modules,
      cols.symbols,
      cols.workspaceDir,
      cols.headHash,
      cols.finishedAt,
      id,
    );
}

/**
 * Delete a repo and its jobs, returning whether a row was removed.
 *
 * Scoped: deleting someone else's private repo must be as impossible as reading
 * it, and returning false (rather than throwing) keeps the caller's 404 path
 * identical to "no such repo".
 *
 * On-disk cleanup is the caller's job — this package does not touch the
 * filesystem, that is `fsx`'s and the caller's boundary.
 */
export function deleteRepo(id: string, viewer: ViewerId): boolean {
  const d = db();
  // Ownership is checked first so a non-owner cannot delete the jobs of a repo
  // they cannot see.
  const visible = d.prepare(`SELECT id FROM repos WHERE id = ? AND ${VISIBLE}`).get(id, bind(viewer));
  if (!visible) return false;
  d.prepare("DELETE FROM jobs WHERE repo_id = ?").run(id);
  const res = d.prepare("DELETE FROM repos WHERE id = ?").run(id);
  return Number(res.changes ?? 0) > 0;
}
