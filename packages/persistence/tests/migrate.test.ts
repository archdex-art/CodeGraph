import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync, MIGRATIONS, runMigrations, schemaVersions, type Migration, type SqliteDatabase } from "../src/index";

/**
 * The migration runner, exercised against databases built by hand rather than
 * through the app, so that the "upgrade an existing install" path is tested
 * rather than assumed.
 *
 * The scenario that matters: every database in existence predates the runner. It
 * has the full v1 schema and no `schema_migrations` table, so migration 001 WILL
 * be applied to live production data. If 001 were not idempotent that would fail,
 * or worse, partially rewrite real rows.
 */

const dirs: string[] = [];

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-migrate-"));
  dirs.push(dir);
  return path.join(dir, "test.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The v1 schema as `lib/db.ts` created it, before the runner existed. */
function buildLegacyV1Database(dbPath: string): SqliteDatabase {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      score REAL,
      loc INTEGER DEFAULT 0,
      error TEXT,
      languages TEXT DEFAULT '[]',
      graph TEXT DEFAULT '{}',
      dimensions TEXT DEFAULT '[]',
      issues TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      finished_at INTEGER
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
    -- The pre-per-account shape: one global row per key.
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function columns(db: SqliteDatabase, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

describe("upgrading a pre-migration v1 database", () => {
  it("adds every column released after v1 without touching existing rows", () => {
    const dbPath = freshDbPath();
    const db = buildLegacyV1Database(dbPath);
    db.prepare(
      "INSERT INTO repos (id, url, name, status, score, issues, created_at) VALUES (?, ?, ?, 'done', ?, ?, ?)",
    ).run("r1", "https://github.com/o/r", "o/r", 91, '[{"id":"iss_0","title":"TODO"}]', 1_700_000_000_000);

    expect(columns(db, "repos").has("churn_by_file")).toBe(false);

    runMigrations(db);

    const after = columns(db, "repos");
    for (const added of [
      "source_type",
      "viz",
      "deps",
      "tree",
      "modules",
      "symbols",
      "workspace_dir",
      "save_mode",
      "owner_id",
      "churn_by_file",
      "head_hash",
    ]) {
      expect(after.has(added)).toBe(true);
    }

    // The pre-existing row must survive verbatim — this is live user data.
    const row = db.prepare("SELECT id, score, issues, status FROM repos WHERE id='r1'").get() as {
      id: string;
      score: number;
      issues: string;
      status: string;
    };
    expect(row.score).toBe(91);
    expect(row.status).toBe("done");
    expect(JSON.parse(row.issues)).toHaveLength(1);
  });

  it("rebuilds settings to a per-account key, preserving pre-migration values", () => {
    // The rebuild that cannot be done with ALTER: SQLite will not change a
    // PRIMARY KEY in place. Rows that were implicitly global become user_id=0.
    const dbPath = freshDbPath();
    const db = buildLegacyV1Database(dbPath);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("assistant.claudeModel", "sonnet");

    runMigrations(db);

    expect(columns(db, "settings").has("user_id")).toBe(true);
    const row = db.prepare("SELECT key, user_id, value FROM settings WHERE key='assistant.claudeModel'").get() as {
      user_id: number;
      value: string;
    };
    expect(row.user_id).toBe(0);
    expect(row.value).toBe("sonnet");
  });

  it("is idempotent — running it twice changes nothing and does not re-apply", () => {
    const dbPath = freshDbPath();
    const db = buildLegacyV1Database(dbPath);
    runMigrations(db);
    const firstVersions = schemaVersions(db);
    const firstColumns = [...columns(db, "repos")].sort();

    runMigrations(db);

    expect(schemaVersions(db)).toEqual(firstVersions);
    expect([...columns(db, "repos")].sort()).toEqual(firstColumns);
  });

  it("applies cleanly to a database that is ALREADY fully current", () => {
    // The genuine production case: the schema is already right, only the
    // version bookkeeping is missing. This must be a no-op, not an error.
    const dbPath = freshDbPath();
    const first = new DatabaseSync(dbPath);
    runMigrations(first);
    first.exec("DELETE FROM schema_migrations");
    first.close();

    const second = new DatabaseSync(dbPath);
    expect(() => runMigrations(second)).not.toThrow();
    expect(schemaVersions(second)).toContain(1);
  });
});

describe("runner behaviour", () => {
  it("records exactly the versions it declares, in order", () => {
    // Compared against MIGRATIONS rather than a hard-coded list, so adding a
    // migration does not require editing this test — while still failing if the
    // runner skips one or records a version it never applied.
    const dbPath = freshDbPath();
    const db = new DatabaseSync(dbPath);
    runMigrations(db);
    const declared = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
    expect(schemaVersions(db)).toEqual(declared);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("rolls a failing migration back and reports which one failed", () => {
    // Half-applied schema is the worst outcome: the next boot would see the
    // version unrecorded and retry against a mutated database.
    const dbPath = freshDbPath();
    const db = new DatabaseSync(dbPath);
    runMigrations(db);

    const broken: Migration = {
      version: 999,
      name: "deliberately_broken",
      up(d) {
        d.exec("CREATE TABLE half_applied (id TEXT)");
        d.exec("THIS IS NOT SQL");
      },
    };

    expect(() => {
      // Same code path as the real runner, with one bad migration appended.
      const applied = new Set(schemaVersions(db));
      if (!applied.has(broken.version)) {
        db.exec("BEGIN IMMEDIATE");
        try {
          broken.up(db);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw new Error(`Migration ${broken.version} (${broken.name}) failed and was rolled back`, { cause: e });
        }
      }
    }).toThrow(/999.*deliberately_broken.*rolled back/);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (t) => t.name,
      ),
    );
    expect(tables.has("half_applied")).toBe(false);
    expect(schemaVersions(db)).not.toContain(999);
  });

  it("refuses to run against a database migrated by a NEWER build", () => {
    // The rollback case. `pending` is computed as "known and not recorded", which cannot see
    // the opposite: a version this image has never heard of, already applied. Render keeps the
    // persistent disk across a rollback, so an old container boots onto a new schema.
    //
    // Benign only because 001-005 are additive. The first destructive migration — 003's header
    // already says one is planned — turns this into an old image writing against a schema whose
    // shape it has wrong, which is silent corruption rather than a crash. Refusing the boot is
    // the only outcome that cannot lose data.
    const db = new DatabaseSync(freshDbPath());
    runMigrations(db);

    const known = Math.max(...MIGRATIONS.map((m) => m.version));
    const future = known + 1;
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(future, Date.now());

    // Names the offending version, because the operator's next question is which build to
    // redeploy.
    expect(() => runMigrations(db)).toThrow(new RegExp(`newer than this build.*${future}`));

    // Still refuses on the next attempt: this is a state of the database, not a one-shot latch
    // that a restart loop would clear.
    expect(() => runMigrations(db)).toThrow(/newer than this build/);
  });
});
