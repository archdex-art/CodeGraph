import type { Dimension } from "@codegraph/core-domain";
import { db } from "./db";

/**
 * Findings, as rows (HLD §11.2).
 *
 * The queries here are the ones a JSON blob could not answer without parsing
 * every finding for a repo: count by dimension, and "what is new since that
 * other run". The second is the fingerprint's whole purpose — it is what makes a
 * baseline, a "new since main" view, and a trend line possible.
 */

export interface FindingRow {
  readonly id: string;
  readonly run_id: string;
  readonly rule_id: string;
  readonly fingerprint: string;
  readonly dimension: string;
  readonly severity: number;
  readonly confidence: number;
  readonly confidence_basis: string;
  readonly analysis_tier: string;
  readonly file: string;
  readonly start_line: number;
  readonly start_col: number;
  readonly end_line: number;
  readonly end_col: number;
  readonly symbol_id: string | null;
  readonly blast_radius: number;
  readonly churn: number;
  readonly score: number | null;
  readonly priority: string | null;
  readonly evidence_json: string;
  readonly status: string;
}

export function findingsForRun(runId: string): FindingRow[] {
  return db()
    .prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY severity DESC, file, start_line")
    .all(runId) as FindingRow[];
}

export function countFindingsByDimension(runId: string): Record<string, number> {
  const rows = db()
    .prepare("SELECT dimension, COUNT(*) AS n FROM findings WHERE run_id = ? GROUP BY dimension")
    .all(runId) as Array<{ dimension: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.dimension] = row.n;
  return out;
}

/**
 * Findings in `runId` whose fingerprint is absent from `baseRunId`.
 *
 * Compared by fingerprint rather than by id or location, which is the point: a
 * finding that merely moved down the file is NOT new, and one that was
 * reformatted is not new either.
 */
export function newFindingsSince(runId: string, baseRunId: string): FindingRow[] {
  return db()
    .prepare(
      `SELECT * FROM findings WHERE run_id = ?
         AND fingerprint NOT IN (SELECT fingerprint FROM findings WHERE run_id = ?)
       ORDER BY severity DESC, file, start_line`,
    )
    .all(runId, baseRunId) as FindingRow[];
}

/** Latest run for a repo, or null. Backfilled repos have exactly one. */
export function latestRunId(repoId: string): string | null {
  const row = db()
    .prepare("SELECT id FROM runs WHERE repo_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(repoId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function suppressFingerprint(
  repoId: string,
  fingerprintValue: string,
  reason: string | null,
  createdBy: number | null,
): void {
  db()
    .prepare(
      `INSERT INTO suppressions (repo_id, fingerprint, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, fingerprint) DO UPDATE SET reason = excluded.reason`,
    )
    .run(repoId, fingerprintValue, reason, createdBy, Date.now());
}

export function suppressedFingerprints(repoId: string): string[] {
  const rows = db().prepare("SELECT fingerprint FROM suppressions WHERE repo_id = ?").all(repoId) as Array<{
    fingerprint: string;
  }>;
  return rows.map((r) => r.fingerprint);
}

/** Narrowing helper for callers that want the domain union rather than a string. */
export function isDimension(value: string): value is Dimension {
  return (
    value === "security" ||
    value === "correctness" ||
    value === "maintainability" ||
    value === "test_integrity" ||
    value === "dependency_hygiene" ||
    value === "performance"
  );
}
