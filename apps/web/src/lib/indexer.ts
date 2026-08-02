/**
 * Re-export shim (LLD §13.1 step 1, §13.2).
 *
 * The analysis pipeline moved to `@codegraph/analysis` so `apps/worker` can run it
 * without importing `apps/web` (`no-cross-app-imports`). That package is
 * transitional — P3 splits it into `pipeline`, `lang-*`, `detect-engine`,
 * `score-engine`, and `viz` per LLD §13.
 *
 * `cloneRepo` / `resolveLocalDir` / `cleanup` are re-exported from `@codegraph/vcs`
 * rather than from `analysis`: they moved there in the earlier step of §13.2,
 * because they shell out to git and §10.2 makes that `vcs`'s exclusive job.
 * Callers importing them from this path predate both moves.
 *
 * Deleted in §13.1 step 3, once no importers remain.
 */
export { indexRepo, scoreIssues } from "@codegraph/analysis";
export { cleanup, cloneRepo, resolveLocalDir } from "@codegraph/vcs";
