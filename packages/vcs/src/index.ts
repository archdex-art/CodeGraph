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
export {
  churnByFile,
  cleanup,
  cloneRepo,
  refreshWorkspace,
  listNonIgnoredFiles,
  resolveLocalDir,
} from "./acquire";

/**
 * Reading a repository out of git rather than off disk.
 *
 * Measured: the git objects for `microsoft/TypeScript` are 41 MB and its checkout is 655 MB,
 * almost all of which analysis reads and discards. These let the pipeline enumerate and read
 * only what it will actually analyse, and leave the working tree to the consumers that need
 * real paths - the editor and the fix sandbox.
 */
export {
  gitTreeFiles,
  hasWorkingTree,
  materialisePaths,
  materialiseWorkingTree,
  readBlobs,
} from "./tree";
export type { TreeEntry } from "./tree";
export {
  gitCommits,
  gitLogRange,
  gitSignals,
  isBotAuthor,
  isFixSubject,
  parseGitLog,
  signalsFromCommits,
  type Commit,
  type FileSignals,
  type GitWindow,
} from "./signals";

export {
  checkoutBranch,
  commit,
  createBranch,
  diffCommitsFile,
  diffRange,
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

/**
 * Ownership, familiarity, reviewer recommendation and symbol-level attribution.
 *
 * Lives in this package for the same reason `signals` does: it is derived from `git log`, and
 * §10.2 makes this the only package allowed to run git. The pure halves (`ownershipReport`,
 * `recommendReviewers`, `parseGitLogHunks`, `symbolOwnership`) take already-read history so
 * they are testable without a repository, exactly as `signalsFromCommits` is.
 */
export {
  authorStats,
  familiarity,
  fileOwnership,
  gitCommitsForRoot,
  gitHunkLog,
  gitOwnership,
  identityKey,
  ownershipReport,
  parseGitLogHunks,
  recommendReviewers,
  staleAreas,
  symbolOwnership,
} from "./ownership";
export type {
  AuthorStat,
  CommitHunks,
  Familiarity,
  FamiliarityEntry,
  FileHunks,
  FileOwner,
  GitOwnershipOptions,
  HunkLogOptions,
  OwnershipEntry,
  OwnershipOptions,
  OwnershipReport,
  ReportOptions,
  ReviewerOptions,
  ReviewerRecommendation,
  StaleArea,
  SymbolAttribution,
  SymbolOwnership,
  SymbolSpan,
} from "./ownership";
