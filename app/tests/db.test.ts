import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Isolated data dir so this file never touches real data or another test
// file's environment (same convention as tenant-isolation.test.ts).
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-db-"));
process.env.CG_DATA_DIR = dataDir;

import { db } from "@/lib/db";

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// Regression guard for the exact class of bug that shipped in the Phase 6
// churn work: a column referenced in store.ts's SQL (churn_by_file) was
// never added to db.ts's CREATE TABLE / migration list, so every real
// indexing run failed with "no such column: churn_by_file" the moment it
// tried to persist -- something no in-memory unit test caught, since none
// of them exercised the actual SQLite write path.
describe("repos table schema matches every column store.ts writes to", () => {
  it("PRAGMA table_info(repos) includes every column referenced by store.ts's UPDATE statements", () => {
    const storeSrc = readFileSync(path.join(__dirname, "..", "src", "lib", "store.ts"), "utf8");
    const updateStatements = [...storeSrc.matchAll(/UPDATE repos SET([\s\S]*?)WHERE/g)];
    expect(updateStatements.length).toBeGreaterThan(0);

    const referencedColumns = new Set<string>();
    for (const m of updateStatements) {
      for (const colMatch of m[1].matchAll(/(\w+)\s*=\s*\?/g)) referencedColumns.add(colMatch[1]);
    }
    expect(referencedColumns.size).toBeGreaterThan(5); // sanity: actually parsed something real

    const actualColumns = new Set(
      (db().prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map((c) => c.name)
    );
    const missing = [...referencedColumns].filter((c) => !actualColumns.has(c));
    expect(missing).toEqual([]);
  });

  it("actually running store.ts's real 'done' UPDATE statement against a live row does not throw", () => {
    const id = randomUUID();
    db()
      .prepare("INSERT INTO repos (id, url, name, source_type, status, created_at) VALUES (?, ?, ?, 'git', 'indexing', ?)")
      .run(id, "https://example.com/x", "x", Date.now());

    expect(() => {
      db()
        .prepare(
          `UPDATE repos SET status='done', score=?, loc=?, languages=?, graph=?, dimensions=?, issues=?, deps=?, churn_by_file=?, viz=?, tree=?, modules=?, symbols=?, workspace_dir=?, finished_at=?
           WHERE id=?`
        )
        .run(85, 100, "[]", "{}", "[]", "[]", "[]", "{}", "{}", "{}", "{}", "{}", "/tmp/x", Date.now(), id);
    }).not.toThrow();

    const row = db().prepare("SELECT status, churn_by_file FROM repos WHERE id=?").get(id) as
      | { status: string; churn_by_file: string }
      | undefined;
    expect(row?.status).toBe("done");
    expect(row?.churn_by_file).toBe("{}");
  });
});
