import { redactCredentials } from "@codegraph/vcs";
import type { ExecResult, FixCandidate, GateResult, SandboxHandle, VerificationGate } from "./types";

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
 */
export async function typesGate(
  sandbox: SandboxHandle,
  hasTypeConfig: () => Promise<boolean>
): Promise<GateResult> {
  const { value: configured, ms: probeMs } = await timed(hasTypeConfig);
  if (!configured) {
    return result("types", "skipped", probeMs, { reason: "no tsconfig.json in the project" });
  }

  const { value, ms } = await timed(() =>
    sandbox.exec("npx", ["tsc", "--noEmit"], { timeoutMs: 180_000, network: false })
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

/**
 * Gate 3 — tests. Run the project's own suite.
 *
 * THE GATE THE PRODUCT'S CREDIBILITY RESTS ON (IDENTITY.md §1: fixes "proved by running
 * your own test suite"). Also the only gate that cannot run everywhere, and the honest
 * handling of that is a `skipped` result plus `level: "partial"` — never a silent pass.
 *
 * Three skip conditions, all real:
 *  · no test script in the manifest — nothing to run;
 *  · `allowTestVerification` off — running a repository's test suite executes ARBITRARY
 *    code from that repository, so it is opt-in rather than default;
 *  · the host cannot isolate — SPIKES §2: Render grants no privileged containers.
 *
 * Network off and timeboxed. A suite that reaches the network is not reproducible, and one
 * that hangs must not hold a lease open.
 */
export async function testsGate(
  sandbox: SandboxHandle,
  opts: {
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
): Promise<GateResult> {
  if (!opts.allowed) {
    return result("tests", "skipped", 0, {
      reason: opts.notAllowedReason ?? "test verification not enabled (CG_ALLOW_TEST_VERIFICATION)",
    });
  }
  if (!opts.canIsolate) {
    return result("tests", "skipped", 0, {
      reason: "host cannot isolate a test run (no privileged container) — see SPIKES §2",
    });
  }

  const { value: runner, ms: probeMs } = await timed(opts.detectRunner);
  if (!runner) {
    return result("tests", "skipped", probeMs, { reason: "no test script in the manifest" });
  }

  const { value, ms } = await timed(() =>
    sandbox.exec(runner.command, runner.args, {
      timeoutMs: opts.timeoutMs ?? 300_000,
      network: false,
    })
  );

  if (value.timedOut) {
    return result("tests", "failed", ms, {
      reason: `test suite exceeded its timeout`,
      log: combined(value),
    });
  }
  return value.code === 0
    ? result("tests", "passed", ms, { reason: `${runner.command} ${runner.args.join(" ")}` })
    : result("tests", "failed", ms, {
        reason: `test suite failed (exit ${value.code})`,
        log: combined(value),
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
