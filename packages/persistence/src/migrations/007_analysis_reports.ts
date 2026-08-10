import type { Migration } from "../migration-type";

/**
 * `repos.ownership_json`, `api_surface_json`, `taint_json`, `unused_deps_json`,
 * `advisories_json` — five analyses that had nowhere to live.
 *
 * Each is produced by `indexRepo` and consumed by a route, and without a column the trip
 * between them ended at the database: the pipeline computed ownership, API entities, taint,
 * unused dependencies and advisories, and `toRepoDetail` had nothing to read them back from,
 * so every route answered as though the analysis had never run.
 *
 * FIVE COLUMNS RATHER THAN ONE `analyses_json` BLOB. The repo row is already one column per
 * analysis (`viz`, `tree`, `modules`, `symbols`, `dimensions`, `issues`) and a blob would be a
 * second convention for the same thing. It also matters that they are independent: a run that
 * produced an API surface but hit a bound in taint writes one and not the other, and a shared
 * blob makes partial results either impossible or silently lossy.
 *
 * NULLABLE, and nullable is load-bearing. NULL means "this run predates the analysis", which
 * every route must render as *not analysed* rather than as an empty result — a repository with
 * no vulnerabilities and a repository nobody checked are different claims, and the difference
 * is exactly what `AdvisoryReport.status` and these NULLs exist to keep apart. An analysis that
 * ran and found nothing writes a present-but-empty report instead.
 *
 * Idempotent via `PRAGMA table_info`, matching migrations 004-006: the runner is ordered and
 * transactional, but a column add that throws on a re-run turns a restart into an outage.
 */
const COLUMNS = [
  "ownership_json",
  "api_surface_json",
  "taint_json",
  "unused_deps_json",
  "advisories_json",
] as const;

export const migration007: Migration = {
  version: 7,
  name: "analysis_reports",
  up(db) {
    const existing = new Set(
      (db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const column of COLUMNS) {
      if (existing.has(column)) continue;
      // The column name is a compile-time constant from the list above, never caller input.
      db.exec(`ALTER TABLE repos ADD COLUMN ${column} TEXT`);
    }
  },
};
