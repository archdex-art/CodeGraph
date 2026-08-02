import type { Migration } from "../migration-type";

/**
 * Findings become ROWS (HLD §11.2, LLD §8.1).
 *
 * v1 stores every finding for a repo as one JSON blob in `repos.issues`. That
 * makes the things a findings list is *for* impossible: you cannot filter or
 * paginate server-side, cannot count by dimension without parsing the whole
 * blob, cannot diff two runs, and cannot attach status to an individual finding.
 * Every read of a single finding pays for all of them.
 *
 * This migration only creates structure. The data move is 003, deliberately
 * separate so a failure while rewriting live rows cannot roll back the schema and
 * leave the two steps ambiguous.
 *
 * `runs` arrives with it because a finding belongs to a run, not to a repo
 * (HLD §7: the run is the unit of immutability — a repo does not have a score, a
 * run has a score). Without it there is nowhere to hang a `run_id`, and the
 * table would need migrating again the moment Timeline needs two runs compared.
 */
export const migration002: Migration = {
  version: 2,
  name: "findings_rows",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        commit_sha TEXT,
        engine_version TEXT NOT NULL,
        score_model_version TEXT NOT NULL,
        status TEXT NOT NULL,
        score REAL,
        loc INTEGER,
        coverage_json TEXT NOT NULL DEFAULT '{}',
        timings_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        dimension TEXT NOT NULL,
        severity INTEGER NOT NULL,
        confidence REAL NOT NULL,
        confidence_basis TEXT NOT NULL,
        analysis_tier TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        start_col INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_col INTEGER NOT NULL,
        symbol_id TEXT,
        blast_radius REAL NOT NULL,
        churn INTEGER NOT NULL DEFAULT 1,
        score REAL,
        priority TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id, priority, score DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_findings_run_dim ON findings(run_id, dimension, severity);

      -- Suppressions key on fingerprint, not id, which is the entire point of
      -- having a fingerprint: a dismissal has to survive the next run.
      CREATE TABLE IF NOT EXISTS suppressions (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        reason TEXT,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, fingerprint)
      );
    `);
  },
};
