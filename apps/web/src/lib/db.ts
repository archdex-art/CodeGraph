import type * as NodeSqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "@codegraph/config";

// node:sqlite is a Node builtin, but Turbopack's dev server (`next dev`)
// mis-externalizes it as `require("node:sqlite")` inside an ESM chunk, where
// `require` is undefined — the module then throws at import time and every
// DB-backed route returns a bodyless 500 ("Failed to load external module
// node:sqlite: ReferenceError: require is not defined"). process.getBuiltinModule
// is the runtime builtin loader that bundlers don't rewrite; it works
// identically in `next dev` and the standalone production build. (The `import
// type` lines above are erased at compile time, so they emit no real import.)
const { DatabaseSync: DatabaseSyncCtor } = process.getBuiltinModule("node:sqlite") as typeof NodeSqlite;

// Singleton DB across hot-reloads / route invocations.
const g = globalThis as unknown as { __cgDb?: DatabaseSync };

/** Resolve the persistent data directory (SQLite + editor workspaces live here). */
export function dataDir(): string {
  return config.dataDir;
}

function init(): DatabaseSync {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSyncCtor(path.join(dir, "codegraph.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'git',
      status TEXT NOT NULL,
      score REAL,
      loc INTEGER DEFAULT 0,
      error TEXT,
      languages TEXT DEFAULT '[]',
      graph TEXT DEFAULT '{}',
      dimensions TEXT DEFAULT '[]',
      deps TEXT DEFAULT '[]',
      issues TEXT DEFAULT '[]',
      viz TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}',
      tree TEXT DEFAULT '{}',
      modules TEXT DEFAULT '{"nodes":[],"edges":[]}',
      symbols TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}',
      churn_by_file TEXT DEFAULT '{}',
      owner_id INTEGER,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS trash (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      orig_path TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      deleted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trash_repo ON trash(repo_id, deleted_at);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 0,
      value TEXT NOT NULL,
      PRIMARY KEY (key, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos(owner_id);
  `);
  // Migrate older installs: add columns introduced after first release.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!cols.has("source_type")) db.exec("ALTER TABLE repos ADD COLUMN source_type TEXT NOT NULL DEFAULT 'git'");
  if (!cols.has("viz")) db.exec(`ALTER TABLE repos ADD COLUMN viz TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}'`);
  if (!cols.has("deps")) db.exec(`ALTER TABLE repos ADD COLUMN deps TEXT DEFAULT '[]'`);
  if (!cols.has("tree")) db.exec(`ALTER TABLE repos ADD COLUMN tree TEXT DEFAULT '{}'`);
  if (!cols.has("modules")) db.exec(`ALTER TABLE repos ADD COLUMN modules TEXT DEFAULT '{"nodes":[],"edges":[]}'`);
  if (!cols.has("symbols")) db.exec(`ALTER TABLE repos ADD COLUMN symbols TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}'`);
  if (!cols.has("workspace_dir")) db.exec("ALTER TABLE repos ADD COLUMN workspace_dir TEXT");
  if (!cols.has("save_mode")) db.exec("ALTER TABLE repos ADD COLUMN save_mode TEXT NOT NULL DEFAULT 'local'");
  if (!cols.has("owner_id")) db.exec("ALTER TABLE repos ADD COLUMN owner_id INTEGER");
  if (!cols.has("churn_by_file")) db.exec(`ALTER TABLE repos ADD COLUMN churn_by_file TEXT DEFAULT '{}'`);
  // The exact commit hash the live workspace was analyzed at (git sources
  // only). Lets the Timeline engine recognize when a requested historical
  // snapshot IS the already-indexed HEAD and reuse that result instead of
  // re-running the full git-archive + indexRepo pipeline for content it has
  // already computed — see TimelineEngine.ensureSnapshot.
  if (!cols.has("head_hash")) db.exec("ALTER TABLE repos ADD COLUMN head_hash TEXT");
  // Migrate the settings table from a single global row-per-key (shared by
  // every visitor) to per-account rows keyed by (key, user_id) — user_id=0
  // is the "no account" bucket (self-hosted/no GitHub sign-in, or an
  // anonymous visitor on a deployment with sign-in configured), matching
  // the same owner_id=NULL "shared public bucket" convention used for
  // repos elsewhere. SQLite can't ALTER a PRIMARY KEY in place, so rebuild:
  // pre-existing rows (all implicitly global before this migration) become
  // user_id=0 rows, preserving today's config for whoever relied on it.
  const settingsCols = new Set(
    (db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!settingsCols.has("user_id")) {
    // Wrap the table rebuild in a transaction: if the process dies mid-migration
    // (after RENAME but before the copy/DROP), an implicit-autocommit run would
    // let the top-level `CREATE TABLE IF NOT EXISTS settings` recreate an EMPTY
    // per-user table on the next boot, orphaning `settings_pre_peruser` and
    // silently losing every pre-migration setting. A transaction makes the whole
    // rebuild atomic — it either fully applies or fully rolls back.
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE settings RENAME TO settings_pre_peruser;
      CREATE TABLE settings (
        key TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        value TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      );
      INSERT INTO settings (key, user_id, value) SELECT key, 0, value FROM settings_pre_peruser;
      DROP TABLE settings_pre_peruser;
      COMMIT;
    `);
  }
  return db;
}

export function db(): DatabaseSync {
  if (!g.__cgDb) g.__cgDb = init();
  return g.__cgDb;
}
