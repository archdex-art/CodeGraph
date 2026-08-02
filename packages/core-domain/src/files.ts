/**
 * Filesystem vocabulary shared by the three layers that touch a workspace
 * listing: `fsx` produces it, an API route serialises it, and the editor UI
 * renders it.
 *
 * It lives in core-domain rather than in `fsx` so the UI can import the type
 * without importing a module that reaches for `node:fs`.
 */
export interface FsEntry {
  readonly name: string;
  /** Workspace-relative, posix separators. Never absolute. */
  readonly path: string;
  readonly type: "file" | "dir";
  /** Bytes. Files only; absent for directories. */
  readonly size?: number;
}
