import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, normalizeSnippet } from "@codegraph/core-domain";
import { DatabaseSync, runMigrations, schemaVersions, type SqliteDatabase } from "../src/index";

/**
 * The findings blob → rows migration, run against a COPY of a v1-shaped database
 * (LLD §8.2, and the phase's definition of done).
 *
 * No production database was available in this environment, so the fixture below
 * is SYNTHESIZED from v1's actual schema and its actual `Issue` shape rather than
 * taken from a real deployment. That is a real limitation and is stated plainly:
 * it verifies the migration against the schema as the v1 code writes it, not
 * against whatever drift a long-lived install may have accumulated. The
 * copy-then-migrate pattern is used regardless, because that is how it must be
 * run for real.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A v1 issue exactly as `mkIssue` in lib/indexer.ts produces it. */
function legacyIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "iss_0",
    dimension: "correctness",
    severity: 1,
    confidence: 1,
    title: "Leftover debug output",
    file: "src/lib/indexer.ts",
    line: 42,
    blastRadius: 3,
    churn: 7,
    ...overrides,
  };
}

/**
 * Build a database with v1's schema and realistic contents, then return the path
 * to a COPY of it — never the original, which is the discipline the real
 * migration run requires.
 */
function seedLegacyDatabaseCopy(issuesByRepo: Record<string, Record<string, unknown>[]>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-backfill-"));
  dirs.push(dir);
  const original = path.join(dir, "production.sqlite");

  const db = new DatabaseSync(original);
  db.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'git', status TEXT NOT NULL, score REAL,
      loc INTEGER DEFAULT 0, error TEXT, languages TEXT DEFAULT '[]',
      graph TEXT DEFAULT '{}', dimensions TEXT DEFAULT '[]', deps TEXT DEFAULT '[]',
      issues TEXT DEFAULT '[]', viz TEXT, tree TEXT, modules TEXT, symbols TEXT,
      churn_by_file TEXT DEFAULT '{}', owner_id INTEGER, workspace_dir TEXT,
      save_mode TEXT NOT NULL DEFAULT 'local', head_hash TEXT,
      created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, status TEXT NOT NULL,
      progress INTEGER DEFAULT 0, message TEXT DEFAULT '', error TEXT
    );
    CREATE TABLE trash (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, orig_path TEXT NOT NULL,
      name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER DEFAULT 0,
      deleted_at INTEGER NOT NULL
    );
    CREATE TABLE settings (
      key TEXT NOT NULL, user_id INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL,
      PRIMARY KEY (key, user_id)
    );
  `);

  const insert = db.prepare(
    `INSERT INTO repos (id, url, name, status, score, loc, issues, head_hash, owner_id, created_at, finished_at)
     VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const [repoId, issues] of Object.entries(issuesByRepo)) {
    n++;
    insert.run(
      repoId,
      `https://github.com/o/${repoId}`,
      `o/${repoId}`,
      90 - n,
      1000 * n,
      JSON.stringify(issues),
      `abc123${n}`,
      n === 1 ? null : 1001,
      1_700_000_000_000 + n,
      1_700_000_100_000 + n,
    );
  }
  db.close();

  const copy = path.join(dir, "production-copy.sqlite");
  copyFileSync(original, copy);
  return copy;
}

function rows(db: SqliteDatabase, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

describe("migrating a v1 database copy forward", () => {
  it("applies every version and records them", () => {
    const dbPath = seedLegacyDatabaseCopy({ repo1: [legacyIssue()] });
    const db = new DatabaseSync(dbPath);

    runMigrations(db);

    expect(schemaVersions(db)).toEqual([1, 2, 3]);
  });

  it("creates one historical run per repo that had findings", () => {
    const dbPath = seedLegacyDatabaseCopy({
      repo1: [legacyIssue()],
      repo2: [legacyIssue({ title: "Use of eval()", dimension: "security", severity: 5 })],
      repo3: [], // no findings — must NOT get a run
    });
    const db = new DatabaseSync(dbPath);

    runMigrations(db);

    const runs = rows(db, "SELECT repo_id, engine_version, status, score FROM runs ORDER BY repo_id");
    expect(runs.map((r) => r["repo_id"])).toEqual(["repo1", "repo2"]);
    expect(runs[0]?.["engine_version"]).toBe("v1-backfill");
    expect(runs[0]?.["status"]).toBe("succeeded");
    // The run carries the repo's score, so a Timeline baseline is meaningful.
    expect(runs[0]?.["score"]).toBe(89);
  });

  it("moves every field the blob actually carried", () => {
    const dbPath = seedLegacyDatabaseCopy({
      repo1: [
        legacyIssue({
          title: "Possible hardcoded secret",
          dimension: "security",
          severity: 5,
          confidence: 0.8,
          file: "src/config/keys.ts",
          line: 17,
          blastRadius: 12,
          churn: 4,
        }),
      ],
    });
    const db = new DatabaseSync(dbPath);

    runMigrations(db);

    const [f] = rows(db, "SELECT * FROM findings");
    expect(f).toBeDefined();
    expect(f?.["rule_id"]).toBe("legacy/possible-hardcoded-secret");
    expect(f?.["dimension"]).toBe("security");
    expect(f?.["severity"]).toBe(5);
    expect(f?.["confidence"]).toBe(0.8);
    expect(f?.["file"]).toBe("src/config/keys.ts");
    expect(f?.["start_line"]).toBe(17);
    expect(f?.["end_line"]).toBe(17);
    expect(f?.["blast_radius"]).toBe(12);
    expect(f?.["churn"]).toBe(4);
    expect(f?.["status"]).toBe("open");
    // Truthful about what v1 actually knew: a line-level regex match.
    expect(f?.["confidence_basis"]).toBe("syntactic");
    expect(f?.["analysis_tier"]).toBe("lexical");
    // The title was the only evidence v1 kept; it is preserved as the rationale.
    expect(JSON.parse(String(f?.["evidence_json"]))).toEqual({
      snippet: "",
      rationale: "Possible hardcoded secret",
    });
  });

  it("leaves repos.issues in place so nothing reading it breaks", () => {
    // The migration is additive on purpose. The app still reads the blob in P1;
    // rewiring that is P3. Dropping the column here would be a behaviour change.
    const dbPath = seedLegacyDatabaseCopy({ repo1: [legacyIssue()] });
    const db = new DatabaseSync(dbPath);

    runMigrations(db);

    const [repo] = rows(db, "SELECT issues FROM repos WHERE id='repo1'");
    expect(JSON.parse(String(repo?.["issues"]))).toHaveLength(1);
  });

  it("computes the fingerprint the same way core-domain does", () => {
    const dbPath = seedLegacyDatabaseCopy({
      repo1: [legacyIssue({ title: "Use of eval()", file: "src/lib/danger.ts" })],
    });
    const db = new DatabaseSync(dbPath);

    runMigrations(db);

    const [f] = rows(db, "SELECT fingerprint FROM findings");
    const expected = fingerprint({
      ruleId: "legacy/use-of-eval",
      scope: "danger.ts",
      normalizedSnippet: normalizeSnippet(""),
    });
    expect(f?.["fingerprint"]).toBe(expected);
  });

  it("gives backfilled findings rule+file granularity, not per-occurrence", () => {
    // The documented consequence of v1 storing no snippet. Asserted rather than
    // left implicit, so anyone who later "fixes" it by folding the line number
    // into the fingerprint has to confront this test and the reasoning in
    // 003_backfill_findings.ts: including the line would make suppressions
    // silently stop matching after a reformat.
    const dbPath = seedLegacyDatabaseCopy({
      repo1: [
        legacyIssue({ title: "TODO/FIXME marker", file: "src/a.ts", line: 10 }),
        legacyIssue({ title: "TODO/FIXME marker", file: "src/a.ts", line: 99 }),
        legacyIssue({ title: "TODO/FIXME marker", file: "src/b.ts", line: 10 }),
      ],
    });
    const db = new DatabaseSync(dbPath);

    runMigrations(db);

    const fps = rows(db, "SELECT fingerprint, file FROM findings ORDER BY file, start_line");
    expect(fps).toHaveLength(3);
    // Same rule, same file → same fingerprint, regardless of line.
    expect(fps[0]?.["fingerprint"]).toBe(fps[1]?.["fingerprint"]);
    // Different file → different fingerprint.
    expect(fps[2]?.["fingerprint"]).not.toBe(fps[0]?.["fingerprint"]);
  });

  it("is deterministic: migrating two copies of the same database agrees exactly", () => {
    // What makes "test it on a copy, then run it for real" a valid strategy.
    const issues = { repo1: [legacyIssue(), legacyIssue({ title: "Use of eval()" })] };
    const first = new DatabaseSync(seedLegacyDatabaseCopy(issues));
    const second = new DatabaseSync(seedLegacyDatabaseCopy(issues));

    runMigrations(first);
    runMigrations(second);

    const a = rows(first, "SELECT id, fingerprint, rule_id FROM findings ORDER BY id");
    const b = rows(second, "SELECT id, fingerprint, rule_id FROM findings ORDER BY id");
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });

  it("survives a corrupt blob without losing other repos", () => {
    // A single unparseable blob must not abort the migration for everything else:
    // those findings are recoverable by re-indexing, a failed boot is not.
    const dbPath = seedLegacyDatabaseCopy({ good: [legacyIssue()] });
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE repos SET issues='{not valid json' WHERE id='good'").run();
    db.prepare(
      `INSERT INTO repos (id, url, name, status, issues, created_at)
       VALUES ('other', 'https://github.com/o/other', 'o/other', 'done', ?, 1)`,
    ).run(JSON.stringify([legacyIssue({ title: "Use of eval()" })]));

    expect(() => runMigrations(db)).not.toThrow();

    const findings = rows(db, "SELECT run_id FROM findings");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.["run_id"]).toBe("run_legacy_other");
  });

  it("tolerates issues with missing or malformed fields", () => {
    // Real blobs predate several fields. NOT NULL columns must still be
    // satisfiable, or the migration fails on exactly the oldest data.
    const dbPath = seedLegacyDatabaseCopy({
      repo1: [
        { title: "Sparse finding" },
        { title: "Bad numbers", severity: "high", line: "nope", blastRadius: null, confidence: undefined },
        {},
      ],
    });
    const db = new DatabaseSync(dbPath);

    expect(() => runMigrations(db)).not.toThrow();

    const findings = rows(db, "SELECT rule_id, severity, start_line, blast_radius, confidence FROM findings ORDER BY id");
    expect(findings).toHaveLength(3);
    expect(findings[1]?.["severity"]).toBe(1); // clamped from garbage
    expect(findings[1]?.["start_line"]).toBe(1);
    expect(findings[1]?.["blast_radius"]).toBe(1);
    expect(findings[2]?.["rule_id"]).toBe("legacy/unknown-finding");
  });
});

describe("what rows unlock that a JSON blob could not", () => {
  it("counts by dimension in SQL", () => {
    const dbPath = seedLegacyDatabaseCopy({
      repo1: [
        legacyIssue({ dimension: "security" }),
        legacyIssue({ dimension: "security", title: "Use of eval()" }),
        legacyIssue({ dimension: "maintainability", title: "TODO/FIXME marker" }),
      ],
    });
    const db = new DatabaseSync(dbPath);
    runMigrations(db);

    const counts = rows(db, "SELECT dimension, COUNT(*) AS n FROM findings GROUP BY dimension ORDER BY dimension");
    expect(counts).toEqual([
      { dimension: "maintainability", n: 1 },
      { dimension: "security", n: 2 },
    ]);
  });

  it("diffs two runs by fingerprint, which is the whole point of having one", () => {
    const dbPath = seedLegacyDatabaseCopy({ repo1: [legacyIssue({ title: "Use of eval()" })] });
    const db = new DatabaseSync(dbPath);
    runMigrations(db);

    // A second run of the same repo that also picked up a new finding.
    db.prepare(
      `INSERT INTO runs (id, repo_id, engine_version, score_model_version, status, started_at)
       VALUES ('run2', 'repo1', 'v2', 'v2', 'succeeded', 2)`,
    ).run();
    const carriedOver = String(
      (db.prepare("SELECT fingerprint FROM findings WHERE run_id='run_legacy_repo1'").get() as {
        fingerprint: string;
      }).fingerprint,
    );
    const insert = db.prepare(
      `INSERT INTO findings (id, run_id, rule_id, fingerprint, dimension, severity, confidence,
        confidence_basis, analysis_tier, file, start_line, start_col, end_line, end_col,
        blast_radius, churn, evidence_json)
       VALUES (?, 'run2', ?, ?, 'security', 5, 1, 'syntactic', 'lexical', 'src/x.ts', 1, 1, 1, 1, 1, 1, '{}')`,
    );
    // Same fingerprint as before → not new, even though the id differs.
    insert.run("f_new_1", "legacy/use-of-eval", carriedOver);
    insert.run("f_new_2", "js/sql-injection", "0123456789abcdef0123456789abcdef");

    const isNew = rows(
      db,
      `SELECT id FROM findings WHERE run_id='run2'
         AND fingerprint NOT IN (SELECT fingerprint FROM findings WHERE run_id='run_legacy_repo1')`,
    );
    expect(isNew.map((r) => r["id"])).toEqual(["f_new_2"]);
  });
});
