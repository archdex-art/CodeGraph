/**
 * The vocabulary a fix provider speaks (LLD §7.1).
 *
 * `FileEdit` moved here from `apps/web/src/lib/agents/executor-types.ts` because two apps now
 * produce and consume it: the web executor and `apps/cli`. It stayed in the app while the app
 * was the only caller; the CLI is what makes it shared vocabulary rather than a local detail.
 *
 * Deliberately NOT re-declared in core-domain. `FileEdit` is line-based, and LLD §7.1's
 * `TextEdit` (range-based, in `@codegraph/verify`) is what replaces it once fixers emit ranges
 * end to end. Promoting a shape that is on its way out into the zero-dependency bottom layer
 * would make it harder to delete, not easier.
 */
export interface FileEdit {
  /** posix, repo-relative */
  file: string;
  /** 1-indexed line affected (for provenance) */
  line: number;
  /** original line (trimmed for display) */
  before: string;
  /** null = line removed */
  after: string | null;
  /** which fixer produced this */
  fixer: string;
  reason: string;
}

export interface FixerInput {
  /** posix repo-relative path */
  rel: string;
  ext: string;
  lines: string[];
}

export interface FixerOutput {
  lines: string[];
  edits: FileEdit[];
}

/**
 * A safe, deterministic codemod over a single file's lines.
 *
 * SAFETY BAR: only transformations that (a) cannot change program behaviour and (b) remove an
 * issue the scorer actually counts. That second half is what keeps a `verified` claim honest —
 * re-indexing must show the score move for a real reason.
 */
export interface Fixer {
  readonly id: string;
  readonly label: string;
  /**
   * Which rule ids this provider fixes (review C1, LLD §7.1 — "THE binding v1 lacks
   * entirely"). Without it, requesting a fix for one finding ran every fixer over every file.
   */
  readonly handles: readonly string[];
  apply(input: FixerInput): FixerOutput;
}

/** Which files and fixers a run is allowed to touch. Absent = the whole repository. */
export interface FixScope {
  /** posix repo-relative file the fix is confined to. */
  readonly file?: string;
  /** Fixer ids permitted to run. */
  readonly fixerIds?: readonly string[];
}
