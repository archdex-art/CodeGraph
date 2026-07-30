import type { GateResult, VerificationGate, VerificationRecord } from "./types";

/**
 * Gates that can never be skipped (LLD §7.2's table).
 *
 * `syntax` and `reanalysis` need nothing from the host: the first re-parses a file the fix
 * just wrote, the second re-runs detection on the patched tree. Neither depends on a
 * toolchain, a manifest, or a container, so a record missing them is a record where
 * verification did not happen — as opposed to one where it partly could not.
 */
const REQUIRED: readonly VerificationGate[] = ["syntax", "reanalysis"];

/**
 * Assemble the record from gate results.
 *
 * Kept separate from the gates so the decision is testable without running a toolchain,
 * and so there is exactly one place that decides what `verified` means. C3 exists because
 * that decision was previously an expression inlined next to the thing it judged.
 */
export function buildRecord(candidateId: string, gates: readonly GateResult[]): VerificationRecord {
  const failed = gates.some((g) => g.status === "failed");
  const ran = new Set(gates.filter((g) => g.status === "passed").map((g) => g.gate));
  const requiredRan = REQUIRED.every((g) => ran.has(g));

  // No failures is NOT sufficient. A run where everything skipped has no failures either,
  // and reporting that as verified is the exact overclaim this phase removes.
  const verified = !failed && requiredRan;

  return {
    candidateId,
    gates,
    verified,
    level: level(verified, gates),
  };
}

function level(verified: boolean, gates: readonly GateResult[]): VerificationRecord["level"] {
  if (!verified) return "none";
  const tests = gates.find((g) => g.gate === "tests");
  // `full` requires the suite to have RUN and PASSED. A skipped test gate is the honest
  // definition of `partial`: everything checkable was checked, and the strongest available
  // evidence — the project's own tests — was not available.
  return tests?.status === "passed" ? "full" : "partial";
}

/**
 * One-line summary for a UI or a PR body.
 *
 * Exists so callers stop composing this string themselves. The shipped PR body says
 * "verified by re-indexing", which a reader hears as "the tests were run" — and for a
 * `partial` record they were not. Naming the level and the gate count makes the claim as
 * strong as the evidence and no stronger.
 */
export function describeRecord(record: VerificationRecord): string {
  if (!record.verified) {
    const failed = record.gates.filter((g) => g.status === "failed").map((g) => g.gate);
    return failed.length > 0
      ? `Not verified — ${failed.join(", ")} failed`
      : `Not verified — required gates did not run`;
  }
  const passed = record.gates.filter((g) => g.status === "passed").map((g) => g.gate);
  return record.level === "full"
    ? `Verified (${passed.join(", ")}) — the project's own tests passed`
    : `Verified (${passed.join(", ")}) — no test suite ran, so this is not test-backed`;
}
