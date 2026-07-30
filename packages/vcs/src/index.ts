/**
 * `@codegraph/vcs` — git and GitHub (LLD §10.2).
 *
 * The only module permitted to import `node:child_process`, enforced by
 * .dependency-cruiser.cjs.
 *
 * Every error path out of here passes through `redactCredentials`, applied at the
 * single `git()` choke point rather than per call site: git embeds the access
 * token in the remote URL and echoes it back in `err.message`, `err.cmd`, and
 * `err.stderr`, so anything that forwards one verbatim leaks a live credential
 * (F004/F017).
 */
export { redactCredentials, redactError } from "./redact";

/**
 * Acquiring and reading a working tree (LLD §13.2). Moved out of
 * `apps/web/src/lib/indexer.ts`, which was shelling out to git directly in
 * contradiction of §10.2 — so this closes a P1 layering gap rather than opening
 * a new seam, and it is what lets `apps/worker` acquire a tree without importing
 * `apps/web`.
 */
export { churnByFile, cleanup, cloneRepo, resolveLocalDir } from "./acquire";

export {
  checkoutBranch,
  commit,
  createBranch,
  diffCommitsFile,
  diffFile,
  getCommitDiffFiles,
  getHeadHash,
  getStatus,
  isGitRepo,
  isGithubHost,
  listBranches,
  log,
  pull,
  push,
  restoreFile,
  withToken,
} from "./git";

export type { CreatePullRequestInput, GitHubClientOptions, PullRequestRef } from "./github";
export { GitHubApiError, createPullRequest, getDefaultBranch, parseGithubRepo } from "./github";

export { isPublicHttpUrl, isSafeReturnPath } from "./urlSafety";
