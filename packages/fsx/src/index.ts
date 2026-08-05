/**
 * `@codegraph/fsx` — capability-scoped filesystem access (LLD §10.1).
 *
 * The only module permitted to import `node:fs`, enforced by
 * .dependency-cruiser.cjs. Everything here is anchored to a workspace root and
 * refuses any path that would escape it, by `..` traversal or by symlink.
 *
 * Prefer `openWorkspace(root)` for new code: a handle cannot hand out a path to
 * be used later, so containment stops being something a call site has to
 * remember. The standalone functions are the same operations for callers that
 * already thread `root` through, and both go through identical validation.
 */
export type { WorkspaceHandle } from "./handle";
export { openWorkspace } from "./handle";

export type { IndexCacheStore } from "./indexCache";
export { MAX_CACHE_BYTES, createIndexCacheStore, dropIndexCacheStore } from "./indexCache";

export type { FsEntry } from "@codegraph/core-domain";
export type { ReadBytesResult, ReadFileResult, SearchMatch } from "./workspace";
export {
  MAX_EDITABLE_BYTES,
  MAX_WRITE_BYTES,
  WorkspacePathError,
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
} from "./workspace";
