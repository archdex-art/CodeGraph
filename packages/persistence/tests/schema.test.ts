import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

// Isolated data dir, set before the connection is opened, so this file never
// touches real data or another test file's database.
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-persistence-schema-"));
process.env["CG_DATA_DIR"] = dataDir;

const { db, schemaVersions } = await import("../src/index");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Relocated from apps/web/tests/db.test.ts, unchanged in strength.
 *
 * It guards the exact bug that shipped in the Phase 6 churn work: a column
 * referenced in the write path (`churn_by_file`) was never added to the schema,
 * so every real indexing run failed with "no such column" the moment it tried to
 * persist — something no in-memory unit test caught, because none of them
 * exercised the actual SQLite write path.
 *
 * It used to scrape `store.ts` for `UPDATE repos SET`. That SQL now lives in this
 * package (LLD §8), so the test follows it here and scrapes `src/repos.ts`
 * instead. Pointing it at a file that no longer contains SQL would have left it
 * passing while checking nothing, which is why the `toBeGreaterThan` sanity
 * assertions below matter as much as the schema comparison.
 */
describe("repos table schema matches every column the write path uses", () => {
  it("PRAGMA table_info(repos) includes every column referenced by an UPDATE", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "repos.ts"), "utf8");
    const updates = [...source.matchAll(/UPDATE repos SET([\s\S]*?)WHERE/g)];
    // If this trips, the SQL moved again and this test is no longer reading it.
    expect(updates.length).toBeGreaterThan(0);

    const referenced = new Set<string>();
    for (const m of updates) {
      for (const col of (m[1] ?? "").matchAll(/(\w+)\s*=\s*\?/g)) {
        const name = col[1];
        if (name) referenced.add(name);
      }
    }
    // Sanity: prove the regex actually parsed real statements, not zero of them.
    expect(referenced.size).toBeGreaterThan(5);

    const actual = new Set(
      (db().prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect([...referenced].filter((c) => !actual.has(c))).toEqual([]);
  });

  it("runs the real 'done' UPDATE against a live row without throwing", () => {
    const id = randomUUID();
    db()
      .prepare(
        "INSERT INTO repos (id, url, name, source_type, status, created_at) VALUES (?, ?, ?, 'git', 'indexing', ?)",
      )
      .run(id, "https://example.com/x", "x", Date.now());

    expect(() => {
      db()
        .prepare(
          `UPDATE repos SET status='done', score=?, loc=?, languages=?, graph=?, dimensions=?,
            issues=?, deps=?, churn_by_file=?, viz=?, tree=?, modules=?, symbols=?,
            workspace_dir=?, head_hash=?, finished_at=?
           WHERE id=?`,
        )
        .run(85, 100, "[]", "{}", "[]", "[]", "[]", "{}", "{}", "{}", "{}", "{}", "/tmp/x", null, Date.now(), id);
    }).not.toThrow();

    const row = db().prepare("SELECT status, churn_by_file FROM repos WHERE id=?").get(id) as
      | { status: string; churn_by_file: string }
      | undefined;
    expect(row?.status).toBe("done");
    expect(row?.churn_by_file).toBe("{}");
  });

  it("records the migration it applied", () => {
    // Opening the connection runs the migrations, so version 1 must be recorded.
    // Without this, a runner that silently applied nothing would look identical
    // to one that worked.
    expect(schemaVersions(db())).toContain(1);
  });

  it("creates every table the app depends on", () => {
    const tables = new Set(
      (
        db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).map((t) => t.name),
    );
    for (const expected of ["repos", "jobs", "trash", "settings", "schema_migrations"]) {
      expect(tables.has(expected)).toBe(true);
    }
  });
});
