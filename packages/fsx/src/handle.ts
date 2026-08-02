import type { FsEntry } from "@codegraph/core-domain";
import {
  createEntry,
  duplicateEntry,
  listDir,
  readWorkspaceBytes,
  readWorkspaceFile,
  renameEntry,
  resolveSafe,
  searchWorkspace,
  writeWorkspaceBytes,
  writeWorkspaceFile,
  type ReadBytesResult,
  type ReadFileResult,
  type SearchMatch,
} from "./workspace";

/**
 * A capability scoped to one workspace root (LLD §10.1).
 *
 * Every method takes a workspace-RELATIVE path and re-validates containment at
 * the moment it runs. That is the point of the shape: the alternative pattern —
 * `const full = resolveSafe(root, rel)` followed later by a raw `fs` call — hands
 * the caller an absolute path whose validity decays the instant it is returned,
 * and makes containment something each call site has to remember. Here it is not
 * possible to hold a path at all.
 *
 * ON THE RESIDUAL TOCTOU WINDOW, stated plainly because the honest version is
 * more useful than a reassuring one: re-checking on every access shrinks the gap
 * between validation and use from "however long the caller keeps the string" to
 * "within a single method call". It does not eliminate it. An attacker who can
 * swap an ancestor directory for a symlink in that window can still escape.
 * Closing it properly needs `openat`-style descriptor-relative traversal, which
 * Node does not expose; `O_NOFOLLOW` is not a substitute and would additionally
 * break legitimate in-repo symlinks that a cloned repository may contain, which
 * v1 deliberately allows so long as they resolve inside the root.
 */
export interface WorkspaceHandle {
  /** Absolute root. Exposed for logging and for git, which needs a cwd. */
  readonly root: string;
  list(rel: string): FsEntry[];
  read(rel: string): ReadFileResult;
  readBytes(rel: string): ReadBytesResult;
  write(rel: string, content: string): void;
  writeBytes(rel: string, bytes: Uint8Array): void;
  create(rel: string, type: "file" | "dir"): void;
  rename(fromRel: string, toRel: string): void;
  duplicate(fromRel: string, toRel: string): void;
  search(query: string, maxResults?: number): SearchMatch[];
  /**
   * Validate `rel` and return the absolute path.
   *
   * The one deliberate escape hatch, and the only method that hands out a raw
   * path. It exists for operations that must cross the workspace boundary —
   * `lib/trash.ts` moves an entry OUT of the workspace into the per-repo trash
   * directory, and restores it back in — which a workspace-scoped API cannot
   * express by construction. Every other caller should use a method above.
   */
  resolve(rel: string): string;
}

/**
 * Open a workspace root.
 *
 * Cheap and stateless: the returned object closes over `root` and holds nothing
 * else, so it is safe to create per request and impossible to share state
 * through (the hazard behind review item B4).
 */
export function openWorkspace(root: string): WorkspaceHandle {
  return {
    root,
    list: (rel) => listDir(root, rel),
    read: (rel) => readWorkspaceFile(root, rel),
    readBytes: (rel) => readWorkspaceBytes(root, rel),
    write: (rel, content) => writeWorkspaceFile(root, rel, content),
    writeBytes: (rel, bytes) => writeWorkspaceBytes(root, rel, bytes),
    create: (rel, type) => createEntry(root, rel, type),
    rename: (fromRel, toRel) => renameEntry(root, fromRel, toRel),
    duplicate: (fromRel, toRel) => duplicateEntry(root, fromRel, toRel),
    search: (query, maxResults) => searchWorkspace(root, query, maxResults),
    resolve: (rel) => resolveSafe(root, rel),
  };
}
