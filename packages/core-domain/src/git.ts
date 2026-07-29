/**
 * Git vocabulary shared by `vcs` (which produces it), the API routes that
 * serialise it, and the editor's Git panel that renders it.
 *
 * Here rather than in `vcs` so the UI can import these types without importing a
 * module that shells out to `git`.
 */

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflicted";

export interface GitStatusEntry {
  readonly path: string;
  readonly status: GitFileStatus;
  readonly staged: boolean;
}

export interface GitStatus {
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly clean: boolean;
  readonly entries: readonly GitStatusEntry[];
  /** HEAD is not on a branch, so a push would go nowhere. */
  readonly detached: boolean;
}

export interface GitBranch {
  readonly name: string;
  readonly current: boolean;
  readonly remote: boolean;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly message: string;
}
