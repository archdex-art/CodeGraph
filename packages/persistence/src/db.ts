import { DatabaseSync as DatabaseSyncCtor, type SqliteDatabase } from "./sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "@codegraph/config";
import { runMigrations } from "./migrate";

/**
 * The SQLite connection. `@codegraph/persistence` is the only module that opens
 * one or writes SQL (HLD §6, LLD §8), enforced by .dependency-cruiser.cjs.
 */

/**
 * Singleton across hot reloads and route invocations.
 *
 * On `globalThis` rather than in a module-level `let` deliberately: Next's dev
 * server re-evaluates modules on change, and a module-scoped handle would leak a
 * new connection (and a new WAL reader) per reload until the process ran out.
 * This is a process-lifetime resource, not per-request state, so it is not the
 * mutable-state hazard behind review item B4.
 */
const g = globalThis as unknown as { __cgDb?: SqliteDatabase };

/** The persistent data directory: SQLite file, its WAL, and editor workspaces. */
export function dataDir(): string {
  return config.dataDir;
}

function open(): SqliteDatabase {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSyncCtor(path.join(dir, "codegraph.sqlite"));
  // WAL lets a reader and the writer coexist, which matters because indexing
  // holds the write path for a while.
  db.exec("PRAGMA journal_mode = WAL;");
  // Without this, a concurrent write fails instantly with SQLITE_BUSY instead of
  // waiting for the other transaction to finish.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

/**
 * The shared database handle.
 *
 * Intended for migrations, the repositories in this package, and schema tests.
 * Application code should go through a repository — those carry the `ViewerId`
 * obligation that makes tenant isolation a type error to forget (LLD §8), and a
 * raw handle silently opts out of it.
 */
export function db(): SqliteDatabase {
  if (!g.__cgDb) g.__cgDb = open();
  return g.__cgDb;
}

/**
 * Drop the cached handle, for tests that need a fresh database.
 *
 * Does not close the connection: node:sqlite has no reference counting, and a
 * caller may still hold a prepared statement from it.
 */
export function resetConnectionForTests(): void {
  delete g.__cgDb;
}

/**
 * The raw `DatabaseSync` constructor and its type.
 *
 * Re-exported because this package owns `node:sqlite` — nothing else may import
 * it (LLD §1.1) — and two legitimate callers need the primitive rather than a
 * repository: the migration tests, which build a database at a chosen path to
 * assert an upgrade works, and the schema tests, which introspect with PRAGMA.
 *
 * Not for application code. A repository carries the `ViewerId` obligation; a
 * bare handle silently opts out of it.
 */
export { DatabaseSyncCtor as DatabaseSync };
export type { SqliteDatabase, SqliteStatement } from "./sqlite";
