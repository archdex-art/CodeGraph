// M4 Remediation Executor domain types.

export interface FileEdit {
  file: string; // posix, repo-relative
  line: number; // 1-indexed line affected (for provenance)
  before: string; // original line (trimmed for display)
  after: string | null; // null = line removed
  fixer: string; // which fixer produced this
  reason: string;
}

export interface ExecutionStep {
  step: number;
  phase: "acquire" | "analyze" | "apply" | "verify" | "diff" | "record";
  detail: string;
  ok: boolean;
  ms: number;
}

export interface PRDraft {
  title: string;
  body: string; // markdown
  branch: string;
  diff: string; // unified git diff
  /** The repository's real default branch, once resolved. Never assumed. */
  base?: string;
  /** True once the branch has been pushed to the remote — i.e. the user's
   *  repository HAS been mutated, whether or not the PR was then created. */
  pushed?: boolean;
  /** Set only when a PR was actually created and GitHub confirmed it. */
  url?: string;
  number?: number;
}

export interface FixResult {
  ok: boolean;
  applied: number; // edits applied
  filesChanged: number;
  edits: FileEdit[];
  scoreBefore: number;
  scoreAfter: number;
  issuesBefore: number;
  issuesAfter: number;
  verified: boolean; // re-index confirmed no score regression
  pr: PRDraft | null;
  steps: ExecutionStep[];
  message: string;
}
