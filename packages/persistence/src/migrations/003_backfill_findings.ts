import { fingerprint, normalizeSnippet } from "@codegraph/core-domain";
import type { Migration } from "../migration-type";
import type { SqliteDatabase } from "../sqlite";

/**
 * Move every `repos.issues` JSON blob into `findings` rows (LLD §8.2).
 *
 * `repos.issues` is deliberately LEFT IN PLACE. The application still reads it in
 * P1 — rewiring the read path is P3 — so this migration is additive and changes
 * no behaviour. Dropping the column is a later migration, once nothing reads it,
 * which also keeps a rollback possible for two releases.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BACKFILLED FINGERPRINT CAN HONESTLY MEAN
 *
 * `fingerprint()` wants (ruleId, scope, normalizedSnippet). A v1 issue carries
 * only `{ title, file, line, dimension, severity, confidence, blastRadius,
 * churn }`. There is no snippet, no rule id, and no enclosing symbol, because v1
 * never recorded them.
 *
 * So a synthesized fingerprint can be one of two things, and neither is ideal:
 *
 *   (a) include the line number → unique per occurrence, but location-DEPENDENT,
 *       which is precisely what a fingerprint must not be. A suppression made
 *       against it would silently stop matching the first time the file is
 *       reformatted — the exact failure fingerprints exist to prevent, and
 *       invisible when it happens.
 *
 *   (b) exclude the line → stable across edits, but coarse: every occurrence of
 *       the same rule in the same file collapses to ONE fingerprint.
 *
 * This migration chooses (b). Coarse and explainable beats precise and lying: a
 * suppression against a backfilled fingerprint suppresses that rule in that file,
 * which is a semantic that can be described to a user in one sentence. Option (a)
 * would produce fingerprints that look per-occurrence and quietly are not
 * durable.
 *
 * Findings produced by the v2 engine will carry a real snippet and symbol, so
 * they get full per-occurrence granularity. Backfilled rows are marked by their
 * `legacy/` rule-id prefix and `confidence_basis = 'syntactic'`, so the two are
 * always distinguishable.
 * ---------------------------------------------------------------------------
 */

/** The v1 `Issue` shape, as stored in the blob. Every field may be absent. */
interface LegacyIssue {
  readonly id?: unknown;
  readonly dimension?: unknown;
  readonly severity?: unknown;
  readonly confidence?: unknown;
  readonly title?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly blastRadius?: unknown;
  readonly churn?: unknown;
}

const ENGINE_VERSION_LEGACY = "v1-backfill";

/**
 * v1 identified a rule only by its human title. This derives a stable,
 * namespaced id from it — `legacy/` so a backfilled row can never be mistaken
 * for, or collide with, a real v2 rule id like `js/sql-injection`.
 */
function legacyRuleId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `legacy/${slug || "unknown"}`;
}

/** Basename, posix-style. The scope granularity v1 data supports (LLD §2.1). */
function basename(file: string): string {
  const parts = file.split("/");
  return parts[parts.length - 1] || file;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseIssues(raw: unknown): LegacyIssue[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LegacyIssue[]) : [];
  } catch {
    // A corrupt blob must not abort the migration for every other repo. The
    // findings are recoverable from a re-index; a failed boot is not.
    return [];
  }
}

interface RepoToBackfill {
  readonly id: string;
  readonly issues: string | null;
  readonly score: number | null;
  readonly loc: number | null;
  readonly head_hash: string | null;
  readonly status: string;
  readonly created_at: number;
  readonly finished_at: number | null;
}

export const migration003: Migration = {
  version: 3,
  name: "backfill_findings",
  up(db: SqliteDatabase) {
    const repos = db
      .prepare(
        `SELECT id, issues, score, loc, head_hash, status, created_at, finished_at
         FROM repos WHERE issues IS NOT NULL AND issues != '' AND issues != '[]'`,
      )
      .all() as RepoToBackfill[];

    const insertRun = db.prepare(
      `INSERT INTO runs (id, repo_id, commit_sha, engine_version, score_model_version,
        status, score, loc, coverage_json, timings_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?)`,
    );
    const insertFinding = db.prepare(
      `INSERT INTO findings (id, run_id, rule_id, fingerprint, dimension, severity,
        confidence, confidence_basis, analysis_tier, file, start_line, start_col,
        end_line, end_col, symbol_id, blast_radius, churn, score, priority,
        evidence_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 'open')`,
    );

    for (const repo of repos) {
      const issues = parseIssues(repo.issues);
      if (issues.length === 0) continue;

      // One synthesized historical run per repo, so existing findings have
      // somewhere to belong and Timeline has a baseline to diff against.
      const runId = `run_legacy_${repo.id}`;
      insertRun.run(
        runId,
        repo.id,
        repo.head_hash,
        ENGINE_VERSION_LEGACY,
        ENGINE_VERSION_LEGACY,
        repo.status === "done" ? "succeeded" : "failed",
        repo.score,
        repo.loc,
        repo.created_at,
        repo.finished_at,
      );

      // Deterministic ids: re-running the backfill on a copy of the same
      // database produces identical rows, which is what makes it safe to test
      // against a copy and then run for real.
      let ordinal = 0;
      for (const issue of issues) {
        const title = asString(issue.title, "Unknown finding");
        const file = asString(issue.file, "");
        const line = Math.max(1, Math.trunc(asNumber(issue.line, 1)));
        const ruleId = legacyRuleId(title);

        insertFinding.run(
          `f_legacy_${repo.id}_${ordinal++}`,
          runId,
          ruleId,
          // Empty normalized snippet: v1 stored none. See the header for why
          // this is rule+file granularity rather than per-occurrence.
          fingerprint({ ruleId, scope: basename(file), normalizedSnippet: normalizeSnippet("") }),
          asString(issue.dimension, "maintainability"),
          Math.min(5, Math.max(1, Math.trunc(asNumber(issue.severity, 1)))),
          asNumber(issue.confidence, 1),
          // v1 matched line-level regexes over raw text. That is exactly what
          // "syntactic" means (LLD §2), and recording it truthfully is what stops
          // a backfilled finding being presented as confidently as a
          // dataflow-verified one.
          "syntactic",
          "lexical",
          file,
          line,
          1,
          line,
          1,
          asNumber(issue.blastRadius, 1),
          Math.trunc(asNumber(issue.churn, 1)),
          // The title is the only evidence v1 kept. Saying so beats an empty
          // object that looks like evidence was lost.
          JSON.stringify({ snippet: "", rationale: title }),
        );
      }
    }
  },
};
