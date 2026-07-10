// Soft-delete layer for the built-in editor: files/folders removed via the
// Explorer are moved (not permanently erased) into a per-repo trash
// directory under the app's persistent data dir, with metadata tracked in
// SQLite. This is what makes editor deletes restorable — including for
// "local" source repos, where the workspace root is the user's real folder
// on disk, so a hard `rm` there would be unrecoverable.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, cpSync, readdirSync } from "node:fs";
import path from "node:path";
import { db, dataDir } from "./db";
import { resolveSafe, WorkspacePathError } from "./workspace";
import type { TrashEntry } from "./types";

// Cap retained trash entries per repo; oldest beyond this are purged
// permanently whenever a new item is trashed, so disk usage stays bounded
// without a background sweep.
const TRASH_CAP = 200;

interface TrashRow {
  id: string;
  orig_path: string;
  name: string;
  type: string;
  size: number;
  deleted_at: number;
}

function trashRoot(repoId: string): string {
  return path.join(dataDir(), "trash", repoId);
}

/** Move `from` to `to`, falling back to copy+remove across filesystem/volume boundaries. */
function moveSync(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function sizeOf(full: string): number {
  const st = statSync(full);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(full)) {
    try {
      total += sizeOf(path.join(full, name));
    } catch {
      /* race/broken symlink, skip */
    }
  }
  return total;
}

function pruneTrash(repoId: string, cap = TRASH_CAP): void {
  const rows = db()
    .prepare("SELECT id FROM trash WHERE repo_id=? ORDER BY deleted_at DESC")
    .all(repoId) as Array<{ id: string }>;
  for (const { id } of rows.slice(cap)) {
    rmSync(path.join(trashRoot(repoId), id), { recursive: true, force: true });
    db().prepare("DELETE FROM trash WHERE id=?").run(id);
  }
}

/** Soft-delete `relPath` under `workspaceRoot`: moves it into the repo's trash and records it. */
export function moveToTrash(repoId: string, workspaceRoot: string, relPath: string): TrashEntry {
  const full = resolveSafe(workspaceRoot, relPath);
  const rel = path.relative(workspaceRoot, full).split(path.sep).join("/");
  if (rel === "" || rel === ".") throw new WorkspacePathError("Cannot delete workspace root");
  if (!existsSync(full)) throw new Error(`Not found: ${relPath}`);

  const st = statSync(full);
  const type: "file" | "dir" = st.isDirectory() ? "dir" : "file";
  const size = sizeOf(full);
  const id = randomUUID();
  const root = trashRoot(repoId);
  mkdirSync(root, { recursive: true });
  const dest = path.join(root, id);
  moveSync(full, dest);

  const entry: TrashEntry = { id, path: rel, name: path.basename(rel), type, size, deletedAt: Date.now() };
  try {
    db()
      .prepare("INSERT INTO trash (id, repo_id, orig_path, name, type, size, deleted_at) VALUES (?,?,?,?,?,?,?)")
      .run(entry.id, repoId, entry.path, entry.name, entry.type, entry.size, entry.deletedAt);
  } catch (e) {
    // DB write failed — move the file back so it never goes untracked in trash.
    moveSync(dest, full);
    throw e;
  }
  pruneTrash(repoId);
  return entry;
}

/** List a repo's trash, most recently deleted first. */
export function listTrash(repoId: string): TrashEntry[] {
  const rows = db()
    .prepare("SELECT * FROM trash WHERE repo_id=? ORDER BY deleted_at DESC")
    .all(repoId) as TrashRow[];
  return rows.map((r) => ({ id: r.id, path: r.orig_path, name: r.name, type: r.type as "file" | "dir", size: r.size, deletedAt: r.deleted_at }));
}

/** Move a trashed entry back to its original location. Fails if something now occupies that path. */
export function restoreFromTrash(repoId: string, workspaceRoot: string, trashId: string): TrashEntry {
  const row = db().prepare("SELECT * FROM trash WHERE id=? AND repo_id=?").get(trashId, repoId) as TrashRow | undefined;
  if (!row) throw new Error("Trash entry not found");

  const target = resolveSafe(workspaceRoot, row.orig_path);
  if (existsSync(target)) throw new Error(`A ${row.type} already exists at ${row.orig_path}`);

  const src = path.join(trashRoot(repoId), row.id);
  if (!existsSync(src)) {
    db().prepare("DELETE FROM trash WHERE id=?").run(row.id);
    throw new Error("Trash contents are gone (already purged)");
  }

  mkdirSync(path.dirname(target), { recursive: true });
  moveSync(src, target);
  db().prepare("DELETE FROM trash WHERE id=?").run(row.id);
  return { id: row.id, path: row.orig_path, name: row.name, type: row.type as "file" | "dir", size: row.size, deletedAt: row.deleted_at };
}

/** Permanently erase one trashed entry. */
export function purgeTrashEntry(repoId: string, trashId: string): void {
  const row = db().prepare("SELECT id FROM trash WHERE id=? AND repo_id=?").get(trashId, repoId);
  if (!row) throw new Error("Trash entry not found");
  rmSync(path.join(trashRoot(repoId), trashId), { recursive: true, force: true });
  db().prepare("DELETE FROM trash WHERE id=?").run(trashId);
}

/** Permanently erase every trashed entry for a repo (also used on repo delete). */
export function emptyTrash(repoId: string): void {
  rmSync(trashRoot(repoId), { recursive: true, force: true });
  db().prepare("DELETE FROM trash WHERE repo_id=?").run(repoId);
}
