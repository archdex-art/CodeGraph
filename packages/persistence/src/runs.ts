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
/**
 * Runs kept per repository. Everything older is deleted on the next `recordRun`.
 *
 * Nothing used to delete a run or a finding, ever, and the arithmetic stopped being
 * academic the day auto-re-index landed: an index used to be a once-per-repo write, and is
 * now up to 360 per hour for an actively edited repo. MEASURED against this exact schema
 * and its three `findings` indexes (100 runs x 200 findings, then WAL checkpointed
 * TRUNCATE): 10,043,392 bytes, i.e. ~100 KB per run. The deployed disk is 1 GB with no
 * backup, so ~10,700 runs fills it and one editing hour costs ~36 MB per user. A full disk
 * is not a degraded mode here — SQLITE_FULL fails every write path, including the migration
 * runner on the next boot.
 *
 * 20 is chosen to keep the diff views useful (`newFindingsSince` compares two runs, and the
 * UI never offers more than a handful back) while capping a repo at ~2 MB.
 */
const RUNS_RETAINED = 20;

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
 * Delete every run for `repoId` beyond the newest `keep`, and their findings with them.
 *
 * Findings go via the `ON DELETE CASCADE` migration 002 put on `findings.run_id`, so this
 * is one statement rather than two — but only while `PRAGMA foreign_keys = ON`, which
 * `open()` sets on every connection. Without it SQLite silently ignores the FK and this
 * would orphan 200 rows per pruned run, which is the larger half of the footprint.
 *
 * Bounded in SQL rather than by reading ids and slicing in JS, for the same reason
 * `pruneTrash` does: a cap on unbounded growth should not itself grow with the thing it
 * bounds. The subquery rides `idx_runs_repo (repo_id, started_at DESC)`, so it is a
 * LIMIT-terminated index scan, not a sort of the repo's history.
 */
export function pruneRunsForRepo(repoId: string, keep: number = RUNS_RETAINED): void {
  db()
    .prepare(
      `DELETE FROM runs
        WHERE repo_id = ?
          AND id NOT IN (SELECT id FROM runs WHERE repo_id = ? ORDER BY started_at DESC LIMIT ?)`
    )
    .run(repoId, repoId, keep);
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
  // BEGIN IMMEDIATE, and OUTSIDE the try. Both halves matter.
  //
  // Outside: an unconditional `ROLLBACK` in the catch below is only correct if the BEGIN
  // succeeded. It can fail — web and worker share one SQLite file and `busy_timeout = 5000`
  // is exhaustible by the other process's index-time write — and then the ROLLBACK throws
  // "cannot rollback - no transaction is active", which REPLACES the real SQLITE_BUSY and
  // hands the caller an error describing the wrong fault entirely.
  //
  // IMMEDIATE: the first statement is an INSERT, so the write lock is taken either way.
  // Taking it up front is what lets busy_timeout do its job — a deferred transaction that
  // reads first and then upgrades gets SQLITE_BUSY with no busy-handler retry, which is
  // unrecoverable rather than merely slow. migrate.ts:49 does this for exactly this reason.
  database.exec("BEGIN IMMEDIATE");
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
    // Inside the transaction, so a run is never visible without its retention already
    // applied and a failed insert cannot delete history it did not replace.
    pruneRunsForRepo(run.repoId);
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
        ORDER BY started_at DESC LIMIT 1`
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

/**
 * Which of `repoIds` were scored over a TRUNCATED walk — the file cap stopped the traversal
 * before it reached the end of the repository.
 *
 * A set, not a map: absent means "the latest run reported no coverage, or none hit the cap",
 * and both render as no marker. The dashboard and the fleet index rank repositories against
 * each other by score, and a sampled score sitting in that ranking beside whole-repository
 * ones without saying so is the overclaim ADR-008 exists to stop.
 *
 * ONE statement for the whole page, for the same reason `repoRunDeltas` below is: this feeds
 * a list view, and `latestRunCoverage` in a loop is the N+1 REVIEW B7 removed from `/api/fleet`.
 */
export function reposScoredOverSample(repoIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (repoIds.length === 0) return out;

  const placeholders = repoIds.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT repo_id, coverage_json AS c FROM (
         SELECT r.repo_id AS repo_id,
                r.coverage_json AS coverage_json,
                ROW_NUMBER() OVER (
                  PARTITION BY r.repo_id ORDER BY r.started_at DESC, r.id DESC
                ) AS rn
           FROM runs r
          WHERE r.repo_id IN (${placeholders}) AND r.status = 'done'
       ) WHERE rn = 1`
    )
    .all(...repoIds) as Array<{ repo_id: string; c: string | null }>;

  for (const row of rows) {
    if (!row.c) continue;
    try {
      const parsed: unknown = JSON.parse(row.c);
      // Narrowed rather than asserted, and `=== true` rather than truthy: a corrupt or
      // pre-ADR-008 blob must read as "not reported", and the only thing allowed to raise
      // this flag is the walk itself having said so.
      if (parsed !== null && typeof parsed === "object" && "capHit" in parsed && parsed.capHit === true) {
        out.add(row.repo_id);
      }
    } catch {
      // A blob that will not parse says nothing about the walk. Claiming a sample would be as
      // much an invention as claiming completeness.
    }
  }
  return out;
}

/**
 * The last two runs of each repo, as the movement between them.
 *
 * The fleet and the dashboard rank by CHANGE, and change is not a property of the repo
 * row — `repos.score` holds the latest value and nothing else, so every earlier reading
 * only exists here. Two runs is all the ranking needs, and taking exactly two keeps this
 * bounded by the caller's page (≤100 repos) rather than by retention (20 runs each).
 *
 * ONE statement, not one per repo: this feeds a list view, and a per-repo query here is
 * the same N+1 that REVIEW B7 removed from `/api/fleet`.
 *
 * A repo with a single run yields `scoreDelta: null` — NOT zero. "No previous index to
 * compare against" and "indexed twice and nothing moved" are different facts, and a fake
 * zero would rank a brand-new repository as the quietest thing in the fleet.
 */
export interface RunDelta {
  /** Findings recorded by the latest run. */
  readonly findings: number;
  /** Latest minus previous. Null when there is no previous run. */
  readonly scoreDelta: number | null;
  readonly findingsDelta: number | null;
}

export function repoRunDeltas(repoIds: readonly string[]): Map<string, RunDelta> {
  const out = new Map<string, RunDelta>();
  if (repoIds.length === 0) return out;

  const placeholders = repoIds.map(() => "?").join(",");
  const rows = db()
    .prepare(
      `SELECT repo_id, score, findings FROM (
         SELECT r.repo_id AS repo_id,
                r.score AS score,
                -- Suppressed findings are excluded on BOTH sides of the subtraction, so
                -- dismissing a finding reads as the improvement it is rather than as noise.
                COUNT(CASE WHEN f.status IS NOT 'suppressed' THEN f.id END) AS findings,
                ROW_NUMBER() OVER (
                  PARTITION BY r.repo_id ORDER BY r.started_at DESC, r.id DESC
                ) AS rn
           FROM runs r LEFT JOIN findings f ON f.run_id = r.id
          WHERE r.repo_id IN (${placeholders}) AND r.status = 'done'
          GROUP BY r.id
       ) WHERE rn <= 2
        ORDER BY repo_id, rn`
    )
    .all(...repoIds) as Array<{ repo_id: string; score: number | null; findings: number }>;

  for (let i = 0; i < rows.length; i++) {
    const latest = rows[i];
    // `noUncheckedIndexedAccess`: the loop bound makes this present, but the compiler is
    // right that indexing does not prove it.
    if (!latest) continue;
    if (out.has(latest.repo_id)) continue; // already consumed as somebody's `latest`
    const previous = rows[i + 1]?.repo_id === latest.repo_id ? rows[i + 1] : undefined;
    out.set(latest.repo_id, {
      findings: latest.findings,
      // A run recorded before scoring existed has a NULL score; a delta against it would
      // be an invention, so it degrades to the same "no comparison" as a first index.
      scoreDelta:
        previous && latest.score !== null && previous.score !== null
          ? Math.round(latest.score - previous.score)
          : null,
      findingsDelta: previous ? latest.findings - previous.findings : null,
    });
  }
  return out;
}
