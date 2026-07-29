/**
 * The slice of Node's built-in SQLite API this package actually uses.
 *
 * Declared as ordinary exported interfaces rather than as an ambient
 * `declare module "node:sqlite"` shim, which is what v1 had at
 * `apps/web/src/types/node-sqlite.d.ts`. The ambient form only applies inside a
 * TypeScript program that happens to include that `.d.ts`, so the moment this
 * code became a package consumed by another workspace, the app's compilation
 * could no longer see it and every `node:sqlite` import failed to resolve.
 *
 * `@types/node` is pinned at ^20, which predates `node:sqlite` (Node 22). When it
 * is bumped to ^22+ this file can be deleted and the real types imported
 * directly — the names match deliberately, so nothing else has to change.
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDatabaseConstructor {
  new (path: string, options?: { open?: boolean; readOnly?: boolean }): SqliteDatabase;
}

/**
 * node:sqlite is a Node builtin, but Turbopack's dev server (`next dev`)
 * mis-externalizes it as `require("node:sqlite")` inside an ESM chunk, where
 * `require` is undefined — the module then throws at import time and every
 * DB-backed route returns a bodyless 500 ("Failed to load external module
 * node:sqlite: ReferenceError: require is not defined").
 *
 * `process.getBuiltinModule` is the runtime builtin loader that bundlers do not
 * rewrite; it behaves identically in `next dev` and in the standalone production
 * build.
 */
const sqliteModule: unknown = process.getBuiltinModule("node:sqlite");

if (!sqliteModule || typeof sqliteModule !== "object" || !("DatabaseSync" in sqliteModule)) {
  // A real check rather than a bare assertion: on Node < 22 the builtin is
  // simply absent, and this says so instead of failing later with
  // "DatabaseSync is not a constructor" from deep inside a repository.
  throw new Error("node:sqlite is unavailable — CodeGraph requires Node >= 22");
}

// Narrowed above; the cast supplies only the shape @types/node@20 cannot.
export const DatabaseSync = sqliteModule.DatabaseSync as SqliteDatabaseConstructor;
