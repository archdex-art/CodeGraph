import { config } from "@codegraph/config";

/**
 * Web-app POLICY for gate 3. The mechanics live in `@codegraph/sandbox`.
 *
 * Split when `apps/cli` needed the same sandbox: `no-cross-app-imports` forbids the CLI
 * importing this app, and duplicating process-isolation mechanics across two hosts is how the
 * timeout, the argv array, and the scrubbed environment quietly diverge. What stayed here is
 * the one part that genuinely differs per host — whether running a stranger's test suite is
 * acceptable at all.
 */

/**
 * Whether this host can isolate a test run well enough to be worth trusting.
 *
 * Opt-in via `CG_ALLOW_TEST_VERIFICATION`, because the honest answer cannot be detected: the
 * process can see that it is in a container, but not whether that container's network and
 * resource limits make running a stranger's test suite acceptable. Only the operator knows.
 *
 * Default off means the hosted demo reports `verified: partial`, which is accurate — Render
 * grants no privileged containers (SPIKES §2). The CLI does not consult this at all: there, the
 * developer's `--verify` flag IS the answer, on their own machine.
 */
export function canIsolateTests(): boolean {
  return config.allowTestVerification;
}
