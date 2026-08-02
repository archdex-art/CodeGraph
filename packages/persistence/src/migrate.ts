import type { SqliteDatabase } from "./sqlite";
import type { Migration } from "./migration-type";
import { MIGRATIONS } from "./migrations/index";

/**
 * Numbered, forward-only migration runner (LLD §8.2).
 *
 * Replaces v1's ad-hoc `if (!cols.has("x")) ALTER TABLE` chain in lib/db.ts.
 * That worked, but it was unauditable — you could not tell which version a
 * database was at — and it could only express *schema* changes, never data ones.
 * The findings-blob → findings-rows move needs a data migration, so the chain
 * had to go.
 */
function appliedVersions(db: SqliteDatabase): Set<number> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

/**
 * Apply every migration not yet recorded, in version order.
 *
 * Rules (LLD §8.2): sequential, never edited after release, always
 * transactional.
 *
 * ON EXISTING DATABASES: a database created before this runner existed has every
 * table and column already but no `schema_migrations` row, so migration 001 will
 * be applied to it. 001 is therefore written to be idempotent — `CREATE TABLE IF
 * NOT EXISTS` plus column-existence checks, exactly the shape v1's `init()` had —
 * so applying it to an already-current database is a no-op that simply records
 * the version. This is what makes adopting the runner safe without a separate
 * baseline step, and it is verified in tests against a database built by the v1
 * code path.
 */
export function runMigrations(db: SqliteDatabase): void {
  const applied = appliedVersions(db);
  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;

  for (const migration of pending) {
    // One transaction per migration, not one for all of them: a failure in 004
    // must not roll back an already-successful 003, or a partially-migrated
    // database would silently retry earlier versions on the next boot.
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read INSIDE the write lock. The `pending` list above was computed
      // without one, and the shipped image boots two processes against the same
      // file (web tier + apps/worker), so both can compute the same pending list
      // and then apply it one after the other. The loser used to fail its boot
      // with "UNIQUE constraint failed: schema_migrations.version" — and for 003,
      // whose backfill ids are deterministic, it would instead die inside `up()`
      // on duplicate finding ids. BEGIN IMMEDIATE serialises the two, so this
      // read is authoritative: if the other process already recorded the version,
      // there is nothing to do. Reproduced with concurrent `tsx` boots against
      // one CG_DATA_DIR.
      const recorded = db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (recorded !== undefined) {
        db.exec("COMMIT");
        continue;
      }
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }
  }
}

/** Versions currently recorded as applied. For diagnostics and tests. */
export function schemaVersions(db: SqliteDatabase): number[] {
  return [...appliedVersions(db)].sort((a, b) => a - b);
}
