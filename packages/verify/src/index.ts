/**
 * `@codegraph/verify` — the four-gate verification harness (LLD §7.2, review C3).
 *
 * Independent of what produced the finding, which is why PLAN.md §4 could promote it ahead
 * of the detection work: it takes a patch and a sandbox. Nothing here parses source,
 * detects anything, or knows a rule from a heuristic — the two capabilities it needs
 * (`parse`, `reanalyse`) are injected by the caller.
 *
 * That is also what keeps it honest about where it runs. Gate 3 executes a repository's own
 * test suite, which is arbitrary code from that repository, so isolation is the caller's
 * decision and the record says plainly when the gate did not run.
 */

export type {
  ExecOptions,
  ExecResult,
  FixCandidate,
  GateResult,
  SandboxHandle,
  SuiteRun,
  SuiteVerdict,
  TextEdit,
  VerificationGate,
  VerificationRecord,
  Verifier,
} from "./types";

export { buildRecord, describeRecord } from "./record";
export {
  pairedTestsGate,
  reanalysisGate,
  runTestSuite,
  syntaxGate,
  testsGate,
  typesGate,
  type TestSuiteOptions,
} from "./gates";
