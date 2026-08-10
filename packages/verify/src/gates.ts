import { redactCredentials } from "@codegraph/vcs";
import type { ExecResult, FixCandidate, GateResult, SandboxHandle, SuiteRun, VerificationGate } from "./types";

/**
 * The four gates (LLD §7.2).
 *
 * Each returns a `GateResult` and never throws: a gate that cannot run reports `skipped`
 * with a reason, and a gate that finds a problem reports `failed`. Throwing would let one
 * unavailable toolchain abandon the whole record, which is how a verification harness ends
 * up reporting less than it actually knows.
 */

/** Logs are for a human reading a failure, not an archive. Bounded on the way in. */
const LOG_LIMIT = 4_000;

function clip(text: string): string {
  // Redacted before truncation, not after: a token split across the boundary would survive
  // the other order.
  const safe = redactCredentials(text).trim();
  return safe.length > LOG_LIMIT ? `${safe.slice(0, LOG_LIMIT)}\n… (truncated)` : safe;
}

function combined(result: ExecResult): string {
  return clip([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

function result(
  gate: VerificationGate,
  status: GateResult["status"],
  ms: number,
  extra: { reason?: string; log?: string } = {}
): GateResult {
  return {
    gate,
    status,
    ms,
    // `exactOptionalPropertyTypes` is on: an explicit `undefined` is not the same as
    // absent, so the keys are added only when present.
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.log !== undefined && extra.log !== "" ? { log: extra.log } : {}),
  };
}

/**
 * Gate 1 — syntax. Re-parse every file the fix touched; zero parse errors.
 *
 * Never skipped, and it is the cheapest possible check on the class of bug that motivated
 * it: review B1 shipped a fixer that deleted a `console.log` forming the entire body of a
 * brace-less `if`, leaving `if (x)` followed by the next statement — which parses as
 * *guarding that statement*. Syntactically valid, semantically wrong. So syntax alone is
 * necessary and not sufficient, which is why gate 4 exists too.
 *
 * `parse` is injected rather than imported: this package must not depend on a language
 * plugin (LLD §1.1 keeps `lang-*` leaves), and P5 replaces the parser under it.
 */
export async function syntaxGate(
  candidate: FixCandidate,
  sandbox: SandboxHandle,
  parse: (file: string, text: string) => { ok: boolean; error?: string },
  readFile: (absPath: string) => Promise<string>
): Promise<GateResult> {
  const files = [...new Set(candidate.edits.map((e) => e.range.file))];
  if (files.length === 0) {
    // A candidate with no edits cannot have broken anything, but it also cannot have fixed
    // anything — gate 4 is what will catch that.
    return result("syntax", "passed", 0, { reason: "no files edited" });
  }

  const { value, ms } = await timed(async () => {
    for (const file of files) {
      const abs = `${sandbox.root}/${file}`;
      let text: string;
      try {
        text = await readFile(abs);
      } catch (e) {
        return { file, error: `could not read edited file: ${String(e)}` };
      }
      const parsed = parse(file, text);
      if (!parsed.ok) return { file, error: parsed.error ?? "parse failed" };
    }
    return null;
  });

  return value === null
    ? result("syntax", "passed", ms, { reason: `${files.length} file(s) re-parsed` })
    : result("syntax", "failed", ms, { reason: `${value.file}: ${value.error}` });
}

/**
 * Gate 2 — types. `tsc --noEmit` when the project is configured for it.
 *
 * Skipped, not failed, when no type config is present: most JavaScript repositories have
 * none, and treating their absence as a failure would make every such fix unverifiable.
 *
 * Runs with the network OFF. `tsc` needs none, and a gate that silently fetches is a gate
 * whose result depends on the network.
 *
 * `compiler` is INJECTED, for the same reason `parse` is — this package must not depend on a
 * language toolchain — and the injected value must be one the ANALYSED REPOSITORY CANNOT
 * CHOOSE. This used to be a literal `sandbox.exec("npx", ["tsc", "--noEmit"])`, and `npx`
 * resolves `./node_modules/.bin/tsc` out of the tree being checked before it looks anywhere
 * else: a repository that commits that path executes its own code in the verifier. Gate 3
 * runs repository code deliberately and is off by default; gate 2 was doing it by accident,
 * with no opt-in at all. `@codegraph/sandbox`'s `typescriptCompiler()` supplies the host's
 * own compiler by absolute path.
 *
 * A null compiler is a SKIP, not a silent pass and not a fallback: "this runtime has no
 * type-checker" is a true statement about the verification, and reaching for the repository's
 * binary to avoid saying it is exactly the trade this gate must not make.
 */
export async function typesGate(
  sandbox: SandboxHandle,
  hasTypeConfig: () => Promise<boolean>,
  compiler: () => { command: string; args: readonly string[] } | null
): Promise<GateResult> {
  const { value: configured, ms: probeMs } = await timed(hasTypeConfig);
  if (!configured) {
    return result("types", "skipped", probeMs, { reason: "no tsconfig.json in the project" });
  }

  const tsc = compiler();
  if (tsc === null) {
    return result("types", "skipped", probeMs, {
      reason: "no TypeScript compiler available to this runtime",
    });
  }

  const { value, ms } = await timed(() =>
    sandbox.exec(tsc.command, [...tsc.args, "--noEmit"], { timeoutMs: 180_000, network: false })
  );

  if (value.timedOut) {
    // Timeout is a failure, not a skip. The check did not complete, and reporting it as
    // skipped would let a pathological project quietly downgrade its own verification.
    return result("types", "failed", ms, { reason: "tsc timed out", log: combined(value) });
  }
  return value.code === 0
    ? result("types", "passed", ms)
    : result("types", "failed", ms, { reason: "tsc reported errors", log: combined(value) });
}

/** What one suite run needs to know about the host it runs on. */
export interface TestSuiteOptions {
  readonly allowed: boolean;
  readonly canIsolate: boolean;
  readonly detectRunner: () => Promise<{ command: string; args: readonly string[] } | null>;
  readonly timeoutMs?: number;
  /**
   * How THIS host explains an opt-out, because the answer differs per host and a wrong one
   * misdirects. The default names `CG_ALLOW_TEST_VERIFICATION`, which is correct for the web
   * app and meaningless in the CLI — where the switch is `--verify` and no such variable
   * exists. A skip reason that points at the wrong lever is the same class of small
   * dishonesty as a `partial` verdict painted green.
   */
  readonly notAllowedReason?: string;
}

/**
 * Run the project's own suite ONCE, and say plainly what happened.
 *
 * Extracted from `testsGate` because the honest verdict needs the suite run TWICE — before the
 * edits and after them (see `pairedTestsGate`). A single run cannot distinguish "this fix broke
 * the suite" from "this suite was already broken", and the executor was reporting the second as
 * if it were evidence about the first.
 *
 * Never throws and never claims more than it did. Three reasons the suite may not run, all
 * real:
 *  · no test command detected — nothing to run;
 *  · `allowTestVerification` off — running a repository's test suite executes ARBITRARY code
 *    from that repository, so it is opt-in rather than default;
 *  · the host cannot isolate — SPIKES §2: Render grants no privileged containers.
 *
 * Network off and timeboxed. A suite that reaches the network is not reproducible, and one that
 * hangs must not hold a lease open.
 */
export async function runTestSuite(
  sandbox: SandboxHandle,
  opts: TestSuiteOptions
): Promise<SuiteRun> {
  if (!opts.allowed) {
    return {
      verdict: "not-allowed",
      reason: opts.notAllowedReason ?? "test verification not enabled (CG_ALLOW_TEST_VERIFICATION)",
      command: null,
      ms: 0,
    };
  }
  if (!opts.canIsolate) {
    return {
      verdict: "not-allowed",
      reason: "host cannot isolate a test run (no privileged container) — see SPIKES §2",
      command: null,
      ms: 0,
    };
  }

  const { value: runner, ms: probeMs } = await timed(opts.detectRunner);
  if (!runner) {
    // Wording carries BOTH halves deliberately: "no test command detected" is what a user is
    // told, "no test script in the manifest" is where we looked.
    return {
      verdict: "no-command",
      reason: "no test command detected — no test script in the manifest",
      command: null,
      ms: probeMs,
    };
  }

  const command = `${runner.command} ${runner.args.join(" ")}`.trim();
  const { value, ms } = await timed(() =>
    sandbox.exec(runner.command, runner.args, {
      timeoutMs: opts.timeoutMs ?? 300_000,
      network: false,
    })
  );
  const log = combined(value);

  if (value.timedOut) {
    return { verdict: "timed-out", reason: "test suite exceeded its timeout", command, ms, ...(log ? { log } : {}) };
  }
  return value.code === 0
    ? { verdict: "passed", reason: command, command, ms }
    : { verdict: "failed", reason: `test suite failed (exit ${value.code})`, command, ms, ...(log ? { log } : {}) };
}

/**
 * Gate 3 — tests, from a single post-fix run.
 *
 * THE GATE THE PRODUCT'S CREDIBILITY RESTS ON (IDENTITY.md §1: fixes "proved by running your
 * own test suite"). Also the only gate that cannot run everywhere, and the honest handling of
 * that is a `skipped` result plus `level: "partial"` — never a silent pass.
 *
 * Kept for the CLI, where the developer runs the fix on their own machine and reads the record
 * themselves: `partial` there is a statement they can act on. Hosts that publish a `verified`
 * claim to someone else should use `pairedTestsGate`, which does not let "we could not check"
 * reach a user as a pass.
 */
export async function testsGate(
  sandbox: SandboxHandle,
  opts: TestSuiteOptions
): Promise<GateResult> {
  const run = await runTestSuite(sandbox, opts);
  const status =
    run.verdict === "passed" ? "passed" : run.verdict === "failed" || run.verdict === "timed-out" ? "failed" : "skipped";
  return result("tests", status, run.ms, {
    reason: run.reason,
    ...(run.log !== undefined ? { log: run.log } : {}),
  });
}

/**
 * Gate 3 — tests, decided by the BEFORE/AFTER pair. The only version that can support the word
 * "verified" in front of a user.
 *
 * WHAT WENT WRONG WITHOUT IT. A real run reported `verified: false` with the message "score
 * regressed" while its own numbers said 72 → 73, and the actual failing step was a reanalysis
 * that never completed. Two separate dishonesties: the verdict rested on a metric the fix was
 * built to move, and the explanation was a guess.
 *
 * The rules, and each rules out a specific false claim:
 *  · the baseline must be GREEN — a repository whose suite was already failing cannot be
 *    verified either way, and reporting the post-fix red as "the fix broke it" blames the fix
 *    for someone else's failure;
 *  · the post-fix run must be GREEN — this is the actual claim;
 *  · a suite that never ran is a FAILED gate, not a skipped one. "No test command detected" is
 *    a reason a fix is unverifiable, not a reason to call it verified.
 *
 * The score does not appear here at all. It is a number the caller reports; it is not evidence.
 */
export function pairedTestsGate(before: SuiteRun, after: SuiteRun): GateResult {
  const ms = before.ms + after.ms;

  /**
   * COULD NOT RUN is not the same as FAILED, and the distinction is the whole `full` vs
   * `partial` axis in `record.ts`. Render grants no privileged containers, so on the default
   * deployment the suite genuinely cannot run — reporting that as a failed gate would mean no
   * fix is ever verifiable there and no PR is ever drafted, which withdraws the feature rather
   * than making it honest. Skipping keeps `verified` reachable at `level: "partial"`, and
   * `describeRecord` is what makes sure nobody reads that as "the tests passed".
   */
  if (before.verdict === "not-allowed" || after.verdict === "not-allowed") {
    const run = before.verdict === "not-allowed" ? before : after;
    return result("tests", "skipped", ms, {
      reason: `the project's test suite was not run, so this fix is not test-verified: ${run.reason}`,
    });
  }
  if (before.verdict === "no-command" || after.verdict === "no-command") {
    return result("tests", "skipped", ms, {
      reason: "no test command detected — this repository has no runnable suite, so nothing can be test-verified here",
    });
  }
  if (before.verdict !== "passed") {
    return result("tests", "failed", ms, {
      reason:
        `the project's own test suite was already failing before any edit (${before.reason}), ` +
        `so this fix cannot be verified either way`,
      ...(before.log !== undefined ? { log: before.log } : {}),
    });
  }
  if (after.verdict !== "passed") {
    return result("tests", "failed", ms, {
      reason: `the fix broke the project's own test suite, which passed before the edits (${after.reason})`,
      ...(after.log !== undefined ? { log: after.log } : {}),
    });
  }
  return result("tests", "passed", ms, {
    reason: `the project's own suite passed before and after the edits (${after.command})`,
  });
}

/**
 * Gate 4 — re-analysis. The target finding's fingerprint must be gone, and no new finding
 * introduced.
 *
 * THE ACTUAL FIX FOR C3. Shipped code asks "did the aggregate score hold?", which is a
 * different question from "was this finding fixed?" and can answer yes when the honest
 * answer is no — an unrelated improvement in the same re-index masks a fix that changed
 * nothing. This asks about the specific claim.
 *
 * Two conditions, and the second is not optional: a fix that removes its target while
 * introducing something new has not earned "verified", even though the finding it was
 * asked about is gone.
 */
export async function reanalysisGate(
  candidate: FixCandidate,
  fingerprintsBefore: ReadonlySet<string>,
  /**
   * The finding this fix claims to remove, or NULL when the caller cannot name one.
   *
   * Null is not a loophole, it is the honest state of the batch path that exists today:
   * `executeFixes` collects edits repo-wide and cannot say which finding each edit served,
   * so there is no target to check. The alternative — picking one, e.g. the
   * highest-severity issue — manufactures a claim the fix never made, and fails whenever no
   * provider handles that particular finding. That is exactly what happened when this was
   * typed `string`: the gate reported "target still present" for a fix that had worked
   * perfectly on the three classes it does handle.
   *
   * With null the gate verifies the half it can — that nothing new was introduced — and its
   * reason says so, so the record cannot be read as proving more. Review C1's per-finding
   * `/fix` is what supplies a real target and unlocks the stronger claim.
   */
  targetFingerprint: string | null,
  reanalyse: () => Promise<ReadonlySet<string>>
): Promise<GateResult> {
  const { value: after, ms } = await timed(reanalyse);

  if (targetFingerprint !== null && after.has(targetFingerprint)) {
    return result("reanalysis", "failed", ms, {
      reason: `the target finding is still present after the fix (fingerprint ${targetFingerprint.slice(0, 12)}…)`,
    });
  }

  const introduced = [...after].filter((fp) => !fingerprintsBefore.has(fp));
  if (introduced.length > 0) {
    return result("reanalysis", "failed", ms, {
      reason: `fix removed its target but introduced ${introduced.length} new finding(s)`,
      log: introduced.slice(0, 10).map((fp) => fp.slice(0, 12)).join(", "),
    });
  }

  return result("reanalysis", "passed", ms, {
    reason:
      targetFingerprint === null
        ? // Deliberately explicit about the weaker claim. A reader must not infer that a
          // specific finding was proven fixed when no finding was named.
          `no new findings introduced; no target finding was named, so this does not prove a specific finding was fixed (candidate ${candidate.providerId})`
        : `target fingerprint absent, no new findings (candidate ${candidate.providerId})`,
  });
}
