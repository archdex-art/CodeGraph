import { fingerprint, normalizeSnippet } from "@codegraph/core-domain";
import { db } from "./db";

/**
 * Writing runs and findings (LLD §8's `FindingRepository.bulkInsert`).
 *
 * WHY THIS EXISTS, and it is not a new feature. Migration 002 created `runs` and `findings`
 * and 003 backfilled them from the existing JSON blobs — and then nothing ever wrote to them
 * again. `completeRepoIndex` UPDATEs `repos` with `issues` as JSON and stops there, so the
 * tables were write-once-at-migration.
 *
 * Measured before writing this: a freshly indexed repository produced 4 issues in the blob,
 * 0 rows in `findings`, 0 rows in `runs`, and `latestRunId()` returned null. So P1's exit
 * criterion — "findings → rows + fingerprints" — held only for data that existed on the day
 * the migration ran.
 *
 * Everything built on those rows was therefore operating on stale or absent data:
 * `newFindingsSince` (the "new since main" view), `countFindingsByDimension`, P6's
 * baseline/PR-scoped modes keyed on `fingerprint`, and — the reason it surfaced now —
 * review C1's per-finding `/fix`, which needs a `findingId` that did not exist for any
 * repository indexed after the backfill.
 *
 * The JSON blob stays authoritative for the UI in this phase. This writes rows ALONGSIDE it
 * rather than replacing it, so nothing that reads `repos.issues` changes behaviour; LLD
 * §13.1 step 2 is what moves readers over, one at a time.
 */

/** Bumped when the analysis pipeline changes in a way that alters findings. */
const ENGINE_VERSION = "v1";
/** Bumped when the scoring model changes. Separate, because they move independently. */
const SCORE_MODEL_VERSION = "v1-b2b3";

/** The shape the analyser produces. Deliberately loose — it is v1's `Issue`, not §2's model. */
export interface AnalysedIssue {
  readonly title?: string;
  readonly dimension?: string;
  readonly severity?: number;
  readonly confidence?: number;
  readonly file?: string;
  readonly line?: number;
  readonly blastRadius?: number;
  readonly churn?: number;
  readonly snippet?: string;
}

export interface NewRun {
  readonly id: string;
  readonly repoId: string;
  readonly commitSha: string | null;
  readonly score: number;
  readonly loc: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  /**
   * What the scan actually looked at (ADR-008), serialised into `coverage_json`.
   *
   * The column has existed since migration 002 and was written as a literal `'{}'` — present
   * in the schema, never populated, so every run claimed the same unknown coverage. Optional
   * here because the backfilled rows genuinely have none.
   */
  // `object`, not the real ScanCoverage type: that lives in `analysis-model`, which
  // persistence may not import (layering — see ALLOWED in .dependency-cruiser.cjs). This
  // package's job is to store the value, not to understand it, and an interface has no
  // implicit index signature so `Record<string, unknown>` would not accept one anyway.
  readonly coverage?: object;
}

/**
 * Slug a title into a rule id.
 *
 * Matches migration 003's `legacyRuleId` by construction, because a finding written today
 * has to be comparable with one backfilled then — `newFindingsSince` diffs the two, and a
 * different slug would report every pre-existing finding as new.
 */
export function legacyRuleId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `legacy/${slug || "unknown"}`;
}

function basename(file: string): string {
  const parts = file.split("/");
  return parts[parts.length - 1] || file;
}

/**
 * Record a completed run and its findings, in one transaction.
 *
 * Atomic on purpose: a run row with no findings is indistinguishable from a repository that
 * genuinely has none, and that is exactly the ambiguity `latestRunId` returning a usable id
 * would then hide.
 */
export function recordRun(run: NewRun, issues: readonly AnalysedIssue[]): void {
  const database = db();
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO runs (id, repo_id, commit_sha, engine_version, score_model_version,
           status, score, loc, coverage_json, timings_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, '[]', ?, ?)`
      )
      .run(
        run.id,
        run.repoId,
        run.commitSha,
        ENGINE_VERSION,
        SCORE_MODEL_VERSION,
        run.score,
        run.loc,
        JSON.stringify(run.coverage ?? {}),
        run.startedAt,
        run.finishedAt
      );

    const insert = database.prepare(
      `INSERT INTO findings (id, run_id, rule_id, fingerprint, dimension, severity,
         confidence, confidence_basis, analysis_tier, file, start_line, start_col,
         end_line, end_col, symbol_id, blast_radius, churn, score, priority,
         evidence_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, NULL, ?, ?, NULL, NULL, '{}', 'open')`
    );

    let ordinal = 0;
    for (const issue of issues) {
      const title = issue.title ?? "Unknown finding";
      const file = issue.file ?? "";
      const line = Math.max(1, Math.trunc(issue.line ?? 1));
      const ruleId = legacyRuleId(title);
      insert.run(
        // Ordinal-suffixed rather than random: re-running the same analysis produces the
        // same ids, which is what makes a run reproducible enough to diff.
        `${run.id}:${ordinal++}`,
        run.id,
        ruleId,
        // Same three inputs migration 003 used, so a finding written now is comparable with
        // one backfilled then. v1 stores no snippet, so this stays rule+file granular — the
        // limitation recorded in REVIEW_2026-07-29 §P1-8, not a new one introduced here.
        fingerprint({
          ruleId,
          scope: basename(file),
          normalizedSnippet: normalizeSnippet(issue.snippet ?? ""),
        }),
        issue.dimension ?? "maintainability",
        Math.min(5, Math.max(1, Math.trunc(issue.severity ?? 1))),
        issue.confidence ?? 1,
        // v1 matches line-level regexes over raw text, which is what "syntactic" means
        // (LLD §2). Recording it truthfully is what stops a regex hit being presented as
        // confidently as a dataflow-verified one.
        "syntactic",
        "lexical",
        file,
        line,
        line,
        issue.blastRadius ?? 0,
        Math.max(1, Math.trunc(issue.churn ?? 1))
      );
    }
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }
}

/** A single finding by id, for the per-finding fix route (review C1). */
export function findingById(id: string): {
  id: string;
  run_id: string;
  rule_id: string;
  fingerprint: string;
  file: string;
  start_line: number;
  severity: number;
  status: string;
} | null {
  const row = db()
    .prepare(
      `SELECT id, run_id, rule_id, fingerprint, file, start_line, severity, status
         FROM findings WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        run_id: string;
        rule_id: string;
        fingerprint: string;
        file: string;
        start_line: number;
        severity: number;
        status: string;
      }
    | undefined;
  return row ?? null;
}

/** The repo a finding belongs to, for the tenant check a route must make before acting. */
export function repoIdForFinding(findingId: string): string | null {
  const row = db()
    .prepare(
      `SELECT r.repo_id AS repoId FROM findings f
         JOIN runs r ON r.id = f.run_id
        WHERE f.id = ?`
    )
    .get(findingId) as { repoId: string } | undefined;
  return row?.repoId ?? null;
}

/**
 * Coverage recorded for a repo's most recent run, or null.
 *
 * Null covers two real cases that must not be conflated with "fully covered": a repo indexed
 * before coverage was recorded, and a repo with no run row at all. The UI renders unknown
 * coverage as unknown — claiming 100% for a run that never reported is the same shape of
 * overclaim as scoring an unmeasured pillar 100.
 */
export function latestRunCoverage(repoId: string): Record<string, unknown> | null {
  const row = db()
    .prepare(
      `SELECT coverage_json AS c FROM runs
        WHERE repo_id = ? AND status = 'done'
        ORDER BY finished_at DESC LIMIT 1`
    )
    .get(repoId) as { c?: string } | undefined;
  if (!row?.c) return null;
  try {
    const parsed = JSON.parse(row.c) as Record<string, unknown>;
    // `'{}'` is what every pre-ADR-008 row holds. Empty means "not reported", not "nothing
    // was skipped".
    return Object.keys(parsed).length === 0 ? null : parsed;
  } catch {
    return null;
  }
}
