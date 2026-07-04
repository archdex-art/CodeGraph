import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Singleton DB across hot-reloads / route invocations.
const g = globalThis as unknown as { __cgDb?: DatabaseSync };

function init(): DatabaseSync {
  const dir = process.env.CG_DATA_DIR || path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "codegraph.sqlite"));
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
  return db;
}

export function db(): DatabaseSync {
  if (!g.__cgDb) g.__cgDb = init();
  return g.__cgDb;
}
