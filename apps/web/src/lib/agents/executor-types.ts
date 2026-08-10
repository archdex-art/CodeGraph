import type { SuiteRun, VerificationRecord } from "@codegraph/verify";
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
  /**
   * Now decided by the four gates (LLD §7.2), not by "the score did not drop".
   * Read `verification` for WHY — this stays a boolean only because existing callers
   * branch on it.
   */
  verified: boolean;
  /** The gate-by-gate record. Absent only on the paths that never ran verification. */
  verification?: VerificationRecord;
  /**
   * Score movement, reported BESIDE the verdict and never as it.
   *
   * Keeping them separate is the point: a run can improve the score and still be unverified,
   * and the version that conflated them printed "verification failed (score regressed)" over
   * a score that had gone up. Absent on paths that never re-analysed.
   */
  scoreDelta?: number;
  /** The project's own suite before any edit — the baseline a verdict is only meaningful against. */
  testsBefore?: SuiteRun;
  /** The same suite after the edits. Green-before + green-after is what "verified" means. */
  testsAfter?: SuiteRun;
  pr: PRDraft | null;
  steps: ExecutionStep[];
  message: string;
}
