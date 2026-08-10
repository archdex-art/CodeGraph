import type { Migration } from "../migration-type";

/**
 * `jobs.phase_json` — what the pipeline is doing RIGHT NOW.
 *
 * The row already carries three things about an in-flight job, and none of them is
 * this one: `progress` is a percentage the caller invents at four fixed points,
 * `stage` is the coarse `cloning|indexing|scoring` the UI's status vocabulary is built
 * from, and `message` is a sentence for a human. Between "Building knowledge graph…"
 * at 55% and "Computing Health Score…" at 85% sits the entire index — which on a real
 * repository is most of the wall clock, and during which all three columns are frozen.
 * That frozen window is the spinner-and-nothing-else the UI showed.
 *
 * A fourth column rather than overloading `message`, for the reason migration 004 gave
 * for splitting `stage` off it: `message` is prose that a route may render verbatim,
 * and a machine-readable phase written into it could not later be formatted, filtered
 * or thrown away without parsing a sentence.
 *
 * JSON, and nullable. `{"stage":"detect","done":231,"total":462}` — counts are absent
 * at a stage boundary, and NULL means "no phase reported", which is the honest state
 * for a queued job, a finished one, and every job that ran before this column existed.
 */
export const migration006: Migration = {
  version: 6,
  name: "job_phase",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "phase_json")) return;
    db.exec("ALTER TABLE jobs ADD COLUMN phase_json TEXT");
  },
};
