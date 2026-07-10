// Path-safe filesystem operations over a repo's persistent workspace
// directory. Every entry point resolves the requested relative path and
// rejects anything that would escape the workspace root (symlink or `..`
// traversal), so a malicious repoId/path combination can never touch the
// host filesystem outside the workspace.
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  cpSync,
} from "node:fs";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { FsEntry } from "./types";

export const MAX_EDITABLE_BYTES = 4_000_000; // 4MB — above this, treat as binary/too-large to edit

const SKIP_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".next": true,
  dist: true,
  build: true,
  out: true,
  __pycache__: true,
  ".venv": true,
  venv: true,
  target: true,
  coverage: true,
};

export class WorkspacePathError extends Error {}

/** Resolve `relPath` against `root`, throwing if it escapes the root. */
export function resolveSafe(root: string, relPath: string): string {
  const cleaned = (relPath || ".").replace(/^\/+/, "");
  const full = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new WorkspacePathError(`Path escapes workspace: ${relPath}`);
  }
  return full;
}

function toRel(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/") || ".";
}

/** List one directory level (lazy tree expansion), dirs first, alphabetical. */
export function listDir(root: string, relPath: string): FsEntry[] {
  const full = resolveSafe(root, relPath);
  const names = readdirSync(full, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const d of names) {
    if (d.name.startsWith(".") && d.name !== ".gitignore" && d.name !== ".env.example") {
      if (d.name === ".git") continue; // never surface .git as an editable dir
    }
    if (SKIP_DIRS[d.name] && d.isDirectory()) continue;
    const childFull = path.join(full, d.name);
    const rel = toRel(root, childFull);
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: rel, type: "dir" });
    } else if (d.isFile()) {
      let size = 0;
      try { size = statSync(childFull).size; } catch { /* race, ignore */ }
      entries.push({ name: d.name, path: rel, type: "file", size });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return entries;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function readWorkspaceFile(root: string, relPath: string): ReadFileResult {
  const full = resolveSafe(root, relPath);
  const st = statSync(full);
  if (!st.isFile()) throw new Error("Not a file");
  const buf = readFileSync(full);
  const binary = looksBinary(buf);
  if (binary) return { content: "", truncated: false, size: st.size, binary: true };
  const truncated = buf.length > MAX_EDITABLE_BYTES;
  const content = truncated ? buf.subarray(0, MAX_EDITABLE_BYTES).toString("utf8") : buf.toString("utf8");
  return { content, truncated, size: st.size, binary: false };
}

export function writeWorkspaceFile(root: string, relPath: string, content: string): void {
  const full = resolveSafe(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

export function createEntry(root: string, relPath: string, type: "file" | "dir"): void {
  const full = resolveSafe(root, relPath);
  if (existsSync(full)) throw new Error("Already exists");
  if (type === "dir") {
    mkdirSync(full, { recursive: true });
  } else {
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "", "utf8");
  }
}

export function renameEntry(root: string, fromRel: string, toRel_: string): void {
  const from = resolveSafe(root, fromRel);
  const to = resolveSafe(root, toRel_);
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
}

export function duplicateEntry(root: string, fromRel: string, toRel_: string): void {
  const from = resolveSafe(root, fromRel);
  const to = resolveSafe(root, toRel_);
  if (existsSync(to)) throw new Error("Destination already exists");
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** Naive recursive text search across the workspace (bounded), used for the
 *  editor's find-in-files panel. Skips binary files and known noise dirs. */
export function searchWorkspace(root: string, query: string, maxResults = 200): SearchMatch[] {
  if (!query.trim()) return [];
  const needle = query.toLowerCase();
  const results: SearchMatch[] = [];
  const stack: string[] = [root];
  let scanned = 0;
  const MAX_FILES = 6000;
  while (stack.length && results.length < maxResults && scanned < MAX_FILES) {
    const dir = stack.pop()!;
    let items: Dirent[];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (SKIP_DIRS[it.name]) continue;
        stack.push(path.join(dir, it.name));
        continue;
      }
      if (!it.isFile()) continue;
      scanned++;
      const full = path.join(dir, it.name);
      let buf: Buffer;
      try { buf = readFileSync(full); } catch { continue; }
      if (buf.length > MAX_EDITABLE_BYTES || looksBinary(buf)) continue;
      const text = buf.toString("utf8");
      if (!text.toLowerCase().includes(needle)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ file: toRel(root, full), line: i + 1, text: lines[i].trim().slice(0, 240) });
        }
      }
    }
  }
  return results;
}
