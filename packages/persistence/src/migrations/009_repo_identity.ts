import type { SqliteDatabase } from "../sqlite";
import type { Migration } from "../migration-type";
import { canonicalTarget } from "../repo-identity";

/**
 * `repos.canonical_target` plus the unique index that makes a repository ONE row.
 *
 * Until now nothing keyed a repo row. `createIndexJob` minted a UUID per submission, so
 * indexing the same target twice inserted a second repository: the dashboard listed
 * `sindresorhus/slugify` four times and `CodeGraph` twice at 92,360 LOC / score 71 and
 * 673,544 LOC / score 76 — two contradictory answers for one codebase, neither marked current.
 * `upsertRepo` closes the hole for new runs; this migration closes it for the rows already on
 * disk and installs the constraint that stops it reopening.
 *
 * THE DE-DUPLICATION IS DESTRUCTIVE, and it has to be: the unique index cannot be created
 * while duplicates exist, and leaving the constraint off would mean the fix only holds until
 * the next code path forgets. The most recently indexed row per key survives — most recent
 * `finished_at` first, because that is the run whose score is current — and the losers are
 * deleted with their jobs, trash, runs, findings and suppressions. A row that never finished
 * loses to one that did regardless of age: an abandoned queued row is not an answer.
 *
 * The surviving row keeps its own id, so one of the duplicate ids stops resolving. That is
 * unavoidable when the id was never stable in the first place, and the alternative — keeping
 * the oldest id and copying the newest row's twenty analysis columns into it — is a data
 * rewrite this migration would have to get exactly right on live data to save a bookmark that
 * points at a stale score.
 *
 * WHAT IT DOES NOT DO: delete the orphaned workspace directories of the removed rows. This
 * package does not touch the filesystem (see `deleteRepo`), and a migration that did would be
 * deleting a user's own folder for a `local` source. They cost disk, not correctness.
 *
 * THE BACKFILL CALLS THE LIVE `canonicalTarget`. If its rules ever change, this migration will
 * not re-run and old rows will keep keys computed under the old rules, so a rules change needs
 * a NEW migration that re-backfills and re-dedupes. That is LLD §8.2's append-only rule applied
 * to a data migration whose logic deliberately lives outside it — duplicating the
 * normalisation here instead would guarantee the two drift apart silently.
 *
 * Idempotent throughout — `PRAGMA table_info` before the ALTER, `IF NOT EXISTS` on the index,
 * and a second run finding no duplicates to remove — matching migrations 004-008.
 */

interface IdentityRow {
  readonly id: string;
  readonly url: string;
  readonly source_type: string;
  readonly owner_id: number | null;
  readonly created_at: number;
  readonly finished_at: number | null;
}

/**
 * Is `a` the more current index of the two?
 *
 * A finished run beats an unfinished one; between two finished runs the later `finished_at`
 * wins; `created_at` then `id` break the remaining ties so the outcome does not depend on the
 * order SQLite happened to return rows in — a migration that deletes different rows on two
 * replicas of the same database is not a migration.
 */
function isMoreCurrent(a: IdentityRow, b: IdentityRow): boolean {
  if ((a.finished_at ?? -1) !== (b.finished_at ?? -1)) return (a.finished_at ?? -1) > (b.finished_at ?? -1);
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id < b.id;
}

/**
 * Remove one repo and everything that hangs off it.
 *
 * Explicit rather than relying on `ON DELETE CASCADE`, because the cascade only fires when
 * `PRAGMA foreign_keys` is ON — true for `openConnection`, not guaranteed for a handle a test
 * or a repair script opened itself. A migration that silently leaves orphaned findings behind
 * on some connections is worse than one that spells the deletes out.
 */
function purgeRepo(db: SqliteDatabase, id: string): void {
  db.prepare("DELETE FROM findings WHERE run_id IN (SELECT id FROM runs WHERE repo_id = ?)").run(id);
  db.prepare("DELETE FROM runs WHERE repo_id = ?").run(id);
  db.prepare("DELETE FROM suppressions WHERE repo_id = ?").run(id);
  db.prepare("DELETE FROM jobs WHERE repo_id = ?").run(id);
  db.prepare("DELETE FROM trash WHERE repo_id = ?").run(id);
  db.prepare("DELETE FROM repos WHERE id = ?").run(id);
}

export const migration009: Migration = {
  version: 9,
  name: "repo_identity",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "canonical_target")) {
      db.exec("ALTER TABLE repos ADD COLUMN canonical_target TEXT");
    }

    const rows = db
      .prepare("SELECT id, url, source_type, owner_id, created_at, finished_at FROM repos")
      .all() as IdentityRow[];
    const setTarget = db.prepare("UPDATE repos SET canonical_target = ? WHERE id = ?");

    // `\u0000` joins the three key parts because it cannot appear in a URL, a path or a source
    // type, so no combination of them can spell another combination's key.
    const survivor = new Map<string, IdentityRow>();
    const doomed: string[] = [];
    for (const row of rows) {
      const target = canonicalTarget(row.source_type, row.url);
      setTarget.run(target, row.id);

      const key = `${row.owner_id ?? -1}\u0000${row.source_type}\u0000${target}`;
      const held = survivor.get(key);
      if (!held) {
        survivor.set(key, row);
        continue;
      }
      if (isMoreCurrent(row, held)) {
        survivor.set(key, row);
        doomed.push(held.id);
      } else {
        doomed.push(row.id);
      }
    }
    for (const id of doomed) purgeRepo(db, id);

    // The constraint the whole migration is for. `COALESCE(owner_id, -1)` because the public
    // bucket stores NULL and NULL is distinct from NULL in a unique index — indexing the raw
    // column would leave every anonymous repository unconstrained, which is most of them on a
    // signed-out install. Rows whose `canonical_target` is NULL (written by raw SQL outside
    // this package, as several test fixtures do) are likewise all distinct and unconstrained,
    // which is the right outcome: no identity was claimed for them.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_identity ON repos(COALESCE(owner_id, -1), source_type, canonical_target)",
    );
  },
};
