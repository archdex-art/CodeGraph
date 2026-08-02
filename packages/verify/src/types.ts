import type { FindingId, SourceRange } from "@codegraph/core-domain";

/**
 * The four-gate verification contract (LLD §7.2, review item C3).
 *
 * WHAT THIS REPLACES, and why it is the point of the phase. Shipped code decides
 * verification in one line (`agents/executor.ts:179`):
 *
 *     const verified = after.score >= before.score && after.issues.length <= before.issues.length;
 *
 * That grades a fix by the metric the fix was built to move, and it answers a question
 * nobody asked. "The aggregate score did not go down" is not evidence that THIS finding
 * was fixed: an unrelated improvement elsewhere in the same re-index masks a fix that did
 * nothing, and a fix that removes the finding while adding a worse one still passes.
 * Meanwhile the PR body it produces says "verified by re-indexing", which a reader will
 * reasonably hear as "the tests were run". They were not.
 *
 * Gate 4 is the correction: the TARGET FINDING'S FINGERPRINT must be absent, and no new
 * finding may appear. That is a question about the specific claim being made.
 */

export type VerificationGate = "syntax" | "types" | "tests" | "reanalysis";

export interface GateResult {
  readonly gate: VerificationGate;
  readonly status: "passed" | "failed" | "skipped";
  /** Why it skipped or failed, e.g. "no test script in package.json". */
  readonly reason?: string;
  readonly ms: number;
  /** Truncated and credential-redacted before it ever reaches this field. */
  readonly log?: string;
}

export interface VerificationRecord {
  readonly candidateId: string;
  readonly gates: readonly GateResult[];
  /**
   * TRUE only if no gate failed AND at least `syntax` + `reanalysis` ran.
   *
   * The floor matters: a record where every gate skipped is not a pass. Those two are the
   * gates that can never be skipped, so requiring them means `verified: true` always rests
   * on something actually executed rather than on an absence of failures.
   */
  readonly verified: boolean;
  /**
   * `full` — the project's own tests ran and passed.
   * `partial` — verified, but no suite ran (none present, or the host cannot isolate one).
   * `none` — not verified.
   *
   * Distinct from `verified` on purpose. Both are true claims and they are not the same
   * claim, and collapsing them is how "verified" came to mean less than a reader assumes.
   * SPIKES §2: Render grants no privileged containers, so gate 3 cannot run on the hosted
   * demo and it reports `partial` there while CLI, desktop, and self-hosted Docker report
   * `full`. The UI must render the two distinctly.
   */
  readonly level: "full" | "partial" | "none";
}

/**
 * Range-based, never line-based — this is what structurally prevents review bug B1.
 *
 * DELIBERATE DEVIATION FROM LLD §7.1, which writes this as
 * `{ file, range: SourceRange, newText }`. `SourceRange` (core-domain) already carries
 * `file`, so the spec's shape holds the path twice and nothing says which wins when they
 * disagree. One source of truth: the path lives on the range. Recorded rather than
 * silently changed, and cheap to reconcile in either direction later.
 */
export interface TextEdit {
  readonly range: SourceRange;
  readonly newText: string;
}

export interface FixCandidate {
  readonly findingId: FindingId;
  readonly providerId: string;
  readonly edits: readonly TextEdit[];
  readonly explanation: string;
  readonly confidence: number;
}

/**
 * A writable copy of the repository that gates may mutate and run commands in.
 *
 * An interface rather than a path so the caller owns the isolation policy: the CLI has the
 * developer's own toolchain and dependencies installed, a container has neither by
 * default, and Render permits no privileged container at all. Handing the verifier a bare
 * string would push that decision into the gate, where it cannot be made correctly.
 */
export interface SandboxHandle {
  /** Absolute path to the working tree the gates operate on. */
  readonly root: string;
  /**
   * Run a command inside the sandbox.
   *
   * The implementation owns the timeout, the network posture, and any resource caps —
   * gates state what they need and do not enforce it themselves.
   */
  exec(command: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
  readonly timeoutMs?: number;
  /** Gate 3 requires this. A test suite that reaches the network is not reproducible. */
  readonly network?: boolean;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the command was killed for exceeding its timeout. */
  readonly timedOut: boolean;
}

export interface Verifier {
  verify(candidate: FixCandidate, sandbox: SandboxHandle): Promise<VerificationRecord>;
}
