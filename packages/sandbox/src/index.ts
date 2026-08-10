/**
 * `@codegraph/sandbox` — process-execution mechanics for verification (LLD §7.2).
 *
 * WHY THIS PACKAGE EXISTS. Gate 2 runs `tsc` and gate 3 runs the analysed repository's own
 * test suite, so verification needs to spawn processes. LLD §10.2's rule — "only `vcs` shells
 * out" — predates those gates: it was written when git was the only subprocess in the design.
 * The sandbox therefore lived in `apps/web`, because apps are outside that rule.
 *
 * That stopped working the moment `apps/cli` needed the same capability. `no-cross-app-imports`
 * forbids the CLI importing `apps/web`, so the choices were to duplicate the sandbox or to name
 * it. Duplicating is how the timeout, the argv array, and the scrubbed environment quietly
 * diverge between two hosts — and those three ARE the security boundary. So the layering rule
 * is amended to name this package, with the reasoning recorded in `.dependency-cruiser.cjs`.
 *
 * MECHANICS ONLY — no policy. Whether gate 3 may run at all is a host question: apps/web
 * requires `CG_ALLOW_TEST_VERIFICATION` because it may be the public demo, while the CLI runs
 * on the developer's own machine where the isolation call is theirs to make (SPIKES §2).
 * `testsGate` already takes `allowed`/`canIsolate` as parameters, so that decision stays with
 * the caller who knows the answer and never leaks in here.
 */
export {
  createSandbox,
  detectTestRunner,
  hasTypeConfig,
  typescriptCompiler,
  type SandboxOptions,
} from "./sandbox";
