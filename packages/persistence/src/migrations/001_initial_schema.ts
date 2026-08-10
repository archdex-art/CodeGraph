import type { SqliteDatabase } from "../sqlite";
import type { Migration } from "../migration-type";

/**
 * The v1 schema, exactly as `lib/db.ts`'s `init()` produced it.
 *
 * Deliberately a faithful port rather than a tidied-up rewrite, and deliberately
 * IDEMPOTENT. Every database in existence predates the migration runner: it has
 * all of these tables and columns already but no `schema_migrations` row, so this
 * migration WILL be applied to production data. Written this way, applying it to
 * an already-current database is a no-op that records version 1 — which is what
 * makes adopting the runner safe without a separate baselining step.
 *
 * Nothing here should be "improved". Renaming a column or tightening a type would
 * rewrite live data, and P1 is structural. New shape goes in a new migration.
 */

/** Columns added after the first release, each with the default v1 used. */
const REPOS_ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["source_type", "TEXT NOT NULL DEFAULT 'git'"],
  ["viz", `TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}'`],
  ["deps", "TEXT DEFAULT '[]'"],
  ["tree", "TEXT DEFAULT '{}'"],
  ["modules", `TEXT DEFAULT '{"nodes":[],"edges":[]}'`],
  [
    "symbols",
    `TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}'`,
  ],
  ["workspace_dir", "TEXT"],
  ["save_mode", "TEXT NOT NULL DEFAULT 'local'"],
  ["owner_id", "INTEGER"],
  ["churn_by_file", "TEXT DEFAULT '{}'"],
  // The exact commit hash the live workspace was analyzed at (git sources
  // only). Lets the Timeline engine recognize when a requested historical
  // snapshot IS the already-indexed HEAD and reuse that result instead of
  // re-running the full git-archive + indexRepo pipeline for content it has
  // already computed — see TimelineEngine.ensureSnapshot.
  ["head_hash", "TEXT"],
];

function columnNames(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export const migration001: Migration = {
  version: 1,
  name: "initial_schema",
  up(db) {
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
      -- VESTIGIAL. The only thing that ever wrote rows here was the AI-assistant
      -- configuration UI (Anthropic key, Claude model, local-LLM base URL and the
      -- saved provider profiles), and CodeGraph is now LLM-free: nothing reads or
      -- writes this table. It is still created, and never dropped, because a
      -- destructive migration is the one change that can stop an existing
      -- deployment from booting — SQLite would have to rebuild the table, and any
      -- older binary rolled back onto the same file would then fail on a missing
      -- table. A handful of dead key/value rows costs nothing; a failed boot on
      -- someone's persistent volume costs everything.
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        value TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      );
    `);

    // Older installs predate these columns. Interpolating the definition is safe
    // because both halves are compile-time constants from the table above, never
    // user input.
    const existing = columnNames(db, "repos");
    for (const [name, definition] of REPOS_ADDED_COLUMNS) {
      if (!existing.has(name)) db.exec(`ALTER TABLE repos ADD COLUMN ${name} ${definition}`);
    }

    // AFTER the ALTERs, not inside the block above — and this ordering is a fix,
    // not a preference. v1 created this index in the same statement as the
    // tables, before adding `owner_id`. On a database old enough to predate that
    // column, `CREATE TABLE IF NOT EXISTS repos` is skipped and the index then
    // references a column that does not exist yet, so boot fails with
    // "no such column: owner_id". Caught by tests/migrate.test.ts building a
    // genuine pre-owner_id database; recorded as P1-6 in
    // docs/REVIEW_2026-07-29.md.
    db.exec("CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos(owner_id);");

    // Migrate `settings` from one global row per key (shared by every visitor) to
    // per-account rows keyed by (key, user_id). user_id=0 is the "no account"
    // bucket — self-hosted with no GitHub sign-in, or an anonymous visitor on a
    // deployment that has it — mirroring the owner_id IS NULL "public bucket"
    // convention used for repos. SQLite cannot ALTER a PRIMARY KEY in place, so
    // the table is rebuilt; pre-existing rows (all implicitly global) become
    // user_id=0, preserving the configuration of whoever relied on it.
    //
    // No explicit BEGIN/COMMIT here, unlike the v1 version: the runner already
    // wraps every migration in a transaction, and a nested BEGIN would throw.
    //
    // Also vestigial now (see the CREATE TABLE above), and kept for the same
    // reason: it only ever runs against a database old enough to still have the
    // single-row-per-key `settings` shape, and removing it would leave that
    // database with a primary key the rest of this migration assumes away.
    if (!columnNames(db, "settings").has("user_id")) {
      db.exec(`
        ALTER TABLE settings RENAME TO settings_pre_peruser;
        CREATE TABLE settings (
          key TEXT NOT NULL,
          user_id INTEGER NOT NULL DEFAULT 0,
          value TEXT NOT NULL,
          PRIMARY KEY (key, user_id)
        );
        INSERT INTO settings (key, user_id, value) SELECT key, 0, value FROM settings_pre_peruser;
        DROP TABLE settings_pre_peruser;
      `);
    }
  },
};
