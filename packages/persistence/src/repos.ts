import type { ViewerId } from "@codegraph/core-domain";
import { db } from "./db";
import { canonicalTarget } from "./repo-identity";

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
  /** Migration 007. NULL means the run predates the analysis, never "nothing found". */
  readonly ownership_json: string | null;
  readonly api_surface_json: string | null;
  readonly taint_json: string | null;
  readonly unused_deps_json: string | null;
  readonly advisories_json: string | null;
  readonly package_names_json: string | null;
  readonly churn_by_file: string;
  /**
   * Migration 009. The identity half of (owner, source type, target) — see `repo-identity.ts`.
   * NULL only on a row written by raw SQL outside this module, which the unique index skips.
   */
  readonly canonical_target: string | null;
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

/**
 * A repository to index.
 *
 * `id` is the id to use IF a row has to be created. `upsertRepo` discards it when the target
 * already has a row, because the whole point is that the existing id survives — links and
 * bookmarks into `/repos/<id>` must keep working across a re-index.
 */
export interface NewRepo {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly sourceType: string;
  readonly ownerId: number | null;
  readonly createdAt: number;
}

export interface UpsertedRepo {
  /** The row's id: `NewRepo.id` for a fresh row, the existing row's id otherwise. */
  readonly id: string;
  readonly created: boolean;
  /**
   * The status the row carried BEFORE this call, or null when it was created.
   *
   * The caller needs it because reusing a row means a re-submission can now land on a
   * repository whose previous run is still in flight, and two runs over one workspace
   * directory is the race the per-repo mutex exists to stop. Reported rather than judged
   * here: which statuses count as busy is the job runner's vocabulary, not this table's.
   */
  readonly previousStatus: string | null;
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
 * The columns the cross-repo fleet graph draws with, and nothing else.
 *
 * `deps` and `package_names_json` are the only JSON blobs here, and both are short arrays of
 * package-name strings — kilobytes, not megabytes. They are the two halves of an edge: what a
 * repository CONSUMES and what it PUBLISHES.
 */
export interface RepoFleetRow {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly source_type: string;
  readonly score: number | null;
  readonly loc: number | null;
  readonly deps: string;
  /** NULL when the run predates migration 008 — nothing can depend on it BY NAME. */
  readonly package_names_json: string | null;
}

/**
 * Finished repos visible to `viewer`, with only the fleet-graph columns.
 *
 * Exists so `/api/fleet` stops issuing `findRepo` per repo (REVIEW B7). That
 * loop ran `SELECT *`, which drags `symbols`, `viz`, `tree`, `modules`, `graph`
 * and `issues` — the symbol graph alone is megabytes of JSON for a large
 * codebase — through SQLite and `JSON.parse` only for the caller to throw them
 * away. On the documented 512 MB / 0.5 vCPU deployment target, 100 of those is
 * an OOM. One statement, eight columns, no blob but the two name arrays.
 *
 * Same `LIMIT 100` as `listRepos` so the fleet shows the same repo set the
 * dashboard does; lifting the cap would change which repos appear, which is a
 * product decision and not this query's to make. `id` breaks `created_at` ties
 * so the row order — and therefore the edge order — is deterministic.
 */
export function listFleetRepos(viewer: ViewerId): RepoFleetRow[] {
  return db()
    .prepare(
      `SELECT id, url, name, source_type, score, loc, deps, package_names_json
       FROM repos WHERE status = 'done' AND ${VISIBLE}
       ORDER BY created_at DESC, id ASC LIMIT 100`,
    )
    .all(bind(viewer)) as RepoFleetRow[];
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

/**
 * Create the row for an index target, or hand back the row that already represents it.
 *
 * UPSERT, NOT INSERT, and that is the fix for duplicate repositories. Keyed on
 * (owner, source type, canonical target) — see `repo-identity.ts` for why a pasted URL is
 * normalised before it is compared. Re-indexing updates in place: the score, findings and
 * finish time that `completeRepoIndex` writes later land on the SAME id, so a repository has
 * exactly one current answer instead of two contradictory ones sitting side by side.
 *
 * `url` and `name` are refreshed on the way through. The canonical target is what makes two
 * spellings one repository; the spelling the user most recently gave is the one to clone with
 * and the one to show them.
 *
 * The status is NOT reset here. A caller that finds `previousStatus` busy must be able to
 * refuse without having already overwritten the evidence that a run is in flight.
 */
export function upsertRepo(repo: NewRepo): UpsertedRepo {
  const d = db();
  const target = canonicalTarget(repo.sourceType, repo.url);
  // `COALESCE(owner_id, -1)` on both sides because the public bucket is NULL and NULL never
  // equals NULL in SQL — a plain `owner_id = ?` would match no anonymous row and duplicate
  // every one of them. -1 is the same impossible-owner sentinel `bind` uses.
  const existing = d
    .prepare(
      `SELECT id, status FROM repos
        WHERE canonical_target = ? AND source_type = ? AND COALESCE(owner_id, -1) = COALESCE(?, -1)`,
    )
    .get(target, repo.sourceType, repo.ownerId) as { id: string; status: string } | undefined;

  if (existing) {
    d.prepare("UPDATE repos SET url = ?, name = ? WHERE id = ?").run(repo.url, repo.name, existing.id);
    return { id: existing.id, created: false, previousStatus: existing.status };
  }

  d.prepare(
    `INSERT INTO repos (id, url, name, source_type, canonical_target, status, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(repo.id, repo.url, repo.name, repo.sourceType, target, repo.ownerId, repo.createdAt);
  return { id: repo.id, created: true, previousStatus: null };
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
   * Analyses added after the first release (migration 007). Pre-serialised like the rest.
   *
   * `null` means the run did not produce one, and every reader must render that as NOT
   * ANALYSED rather than as an empty result: a repository with no vulnerabilities and a
   * repository nobody checked are different claims. A run that DID look writes a
   * present-but-empty report instead, which is why these are nullable rather than defaulting
   * to `"[]"`.
   */
  readonly ownership: string | null;
  readonly apiSurface: string | null;
  readonly taint: string | null;
  readonly unusedDeps: string | null;
  readonly advisories: string | null;
  readonly packageNames: string | null;
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
        ownership_json=?, api_surface_json=?, taint_json=?, unused_deps_json=?, advisories_json=?,
        package_names_json=?,
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
      cols.ownership,
      cols.apiSurface,
      cols.taint,
      cols.unusedDeps,
      cols.advisories,
      cols.packageNames,
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
