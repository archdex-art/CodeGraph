import type { Migration } from "../migration-type";

/**
 * Counters for `/api/metrics` (HLD §14).
 *
 * WHY A TABLE RATHER THAN A PROCESS-LOCAL COUNTER, which is how every Prometheus client
 * library does it. Two reasons specific to this architecture, and both make in-memory the
 * wrong answer rather than merely a weaker one:
 *
 *  1. ADR-001 spawns a CHILD PROCESS PER JOB and lets it exit. Anything the executor counts
 *     in memory dies with that process, and `/api/metrics` is served by the web tier — so the
 *     web process would report zero for work it did not do itself. The one metric HLD calls
 *     "the metric that keeps the product honest" would be structurally blind to the process
 *     that does the work.
 *  2. A counter that resets on deploy cannot answer "how often does our fix actually pass the
 *     tests?" It answers "since the last restart", which for a self-hosted container is a
 *     window nobody chose.
 *
 * The cost is a row write per event and a scan per scrape. Both are trivially small against
 * one SQLite file, and this is the same argument HLD §14 already makes for the run record:
 * "self-observability that works with no external stack, which matters for the self-host
 * story."
 *
 * This also sidesteps LLD §1.1's ban on module-level mutable state in packages (which retired
 * review B4) rather than carving an exception out of it: the state lives in the database, so
 * the module stays a pure function of it.
 */
export const migration005: Migration = {
  version: 5,
  name: "metrics_counters",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metric_counters (
        -- Metric name plus its label set, e.g. 'cg_verification_total{gate="tests",outcome="passed"}'.
        -- One row per distinct label combination, which is exactly Prometheus' own model.
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        labels_json TEXT NOT NULL DEFAULT '{}',
        value REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      -- Scrapes render one metric family at a time, so the endpoint reads by name.
      CREATE INDEX IF NOT EXISTS idx_metric_counters_name ON metric_counters(name);
    `);
  },
};
