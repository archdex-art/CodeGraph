import {
  DatabaseSync as DatabaseSyncCtor,
  type SqliteDatabase,
  type SqliteDatabaseConstructor,
} from "./sqlite";
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

/** Sleep on this thread. `DatabaseSync` is synchronous, so the retry below must be too. */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Open and initialise one connection under `dir`.
 *
 * `Ctor` is a parameter only so a test can drive the failure path below; production has one
 * caller and it takes the default.
 */
export function openConnection(
  dir: string,
  Ctor: SqliteDatabaseConstructor = DatabaseSyncCtor,
): SqliteDatabase {
  mkdirSync(dir, { recursive: true });
  const db = new Ctor(path.join(dir, "codegraph.sqlite"));
  // EVERYTHING past the constructor is inside the try, because everything past the
  // constructor can throw: a corrupt or truncated file ("file is not a database") at the
  // first pragma, ENOSPC or EACCES on the WAL conversion, the explicit 5 s deadline below,
  // or any migration failing. The handle is a local until `g.__cgDb` is assigned on success,
  // so an escaping throw dropped it unreferenced — and node:sqlite frees a `DatabaseSync`
  // only on `close()`, not on GC. Each failed `db()` therefore leaked an fd, a page cache
  // and an shm mapping, once PER REQUEST, on a 512 MB container that keeps serving because
  // /api/health never touches the database. Degraded mode was a slow OOM, not a degradation.
  try {
    // busy_timeout FIRST, before any other pragma. Without a busy handler
    // installed, every subsequent lock wait fails instantly with SQLITE_BUSY
    // ("database is locked") whenever a second process touches the same file —
    // which the shipped image does on every boot, since the container runs the web
    // tier and `apps/worker` side by side and `db()` opens lazily on first use.
    // Reproduced with concurrent `tsx` processes against one CG_DATA_DIR: ~7 of 8
    // races threw at the WAL pragma below.
    db.exec("PRAGMA busy_timeout = 5000;");

    // WAL lets a reader and the writer coexist, which matters because indexing
    // holds the write path for a while.
    //
    // Retried rather than executed once, because busy_timeout does NOT cover this
    // statement: converting the journal mode needs an exclusive lock, and SQLite
    // returns SQLITE_BUSY for a journal_mode change without invoking the busy
    // handler. That is only reachable on the FIRST open of a new file — the
    // container's cold start on an empty persistent disk, where both processes
    // race to convert the same rollback-mode database — and the loser used to die
    // with an unhandled "database is locked". One process wins, so the loser's next
    // read simply sees `wal` and stops.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      if (mode?.journal_mode?.toLowerCase() === "wal") break;
      // The deadline bounds BOTH failure shapes: the pragma throwing, and the
      // pragma returning without having converted. Neither may spin forever.
      if (Date.now() >= deadline) {
        throw new Error(`Could not put ${dir} into WAL mode: still ${mode?.journal_mode ?? "unknown"}`);
      }
      try {
        db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        Atomics.wait(SLEEP_BUFFER, 0, 0, 25);
      }
    }

    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {
      // `close()` on a handle whose file is already unusable can itself throw, and
      // letting that escape would replace the real cause with a bookkeeping error —
      // the same substitution the ROLLBACK in runs.ts used to make. The caller needs
      // the reason the open failed; a close that could not complete adds nothing.
    }
    throw e;
  }
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
  if (!g.__cgDb) g.__cgDb = openConnection(dataDir());
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
