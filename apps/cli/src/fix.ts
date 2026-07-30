import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexRepo } from "@codegraph/analysis";
import { fingerprint, normalizeSnippet } from "@codegraph/core-domain";
import {
  applyFixes,
  candidateFor,
  FIXERS,
  fixersForRule,
  legacyRuleIdFor,
  parseCheck,
  type FileChange,
} from "@codegraph/remediate-engine";
import { createSandbox, detectTestRunner, hasTypeConfig } from "@codegraph/sandbox";
import {
  buildRecord,
  describeRecord,
  reanalysisGate,
  syntaxGate,
  testsGate,
  typesGate,
  type GateResult,
  type VerificationRecord,
} from "@codegraph/verify";

/**
 * `codegraph fix` — remediation verified where the developer already is (SPIKES.md §2).
 *
 * WHY THE CLI IS THE PRIMARY VEHICLE, not a convenience wrapper. Gate 3 runs the analysed
 * repository's own test suite, which needs an isolated container. Render grants none, so the
 * hosted demo can only ever report `verified: partial` — SPIKES §2 worked this through and
 * concluded the full loop belongs where the developer lives: the toolchain is installed, the
 * dependencies are there, and the isolation question is the developer's own call.
 *
 * That is not a workaround for a hosting limitation. It is what CodeGraph already claims to be
 * — a tool you run on your own code, on your own machine, with no key (IDENTITY.md §2).
 *
 * NEVER TOUCHES THE ORIGINAL. Everything happens in a temp copy, and the result is a diff the
 * developer applies themselves. Writing into someone's working tree while their editor is open
 * is not a feature, and `--apply` is deliberately absent until there is a reason to add it.
 */

export interface FixOptions {
  /** Path to the repository. */
  readonly repo: string;
  /** Run gate 3 (the repository's test suite). The developer's machine, the developer's call. */
  readonly verify: boolean;
  /** Only fix findings of this rule id. */
  readonly rule?: string;
  /** Only fix this repo-relative file. */
  readonly file?: string;
  readonly json: boolean;
  /** Seconds for gate 3 before SIGKILL. */
  readonly testTimeout: number;
}

export interface FixOutcome {
  readonly editCount: number;
  readonly filesChanged: number;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly issuesBefore: number;
  readonly issuesAfter: number;
  readonly record: VerificationRecord | null;
  readonly diff: string;
  readonly summary: string;
}

const fingerprintsOf = (issues: readonly { title: string; file: string; snippet?: string }[]) =>
  new Set(
    issues.map((i) =>
      fingerprint({
        ruleId: legacyRuleIdFor(i.title),
        scope: path.basename(i.file),
        normalizedSnippet: normalizeSnippet(i.snippet ?? ""),
      })
    )
  );

export async function runFix(opts: FixOptions): Promise<FixOutcome> {
  const source = path.resolve(opts.repo);

  // A disposable copy. `cpSync` with a filter rather than a clone: the CLI runs against a
  // working directory that may have uncommitted changes, and those are exactly what the
  // developer wants checked. A `git clone` would silently analyse HEAD instead.
  const work = mkdtempSync(path.join(tmpdir(), "cg-fix-"));
  try {
    cpSync(source, work, {
      recursive: true,
      filter: (s) => !/(^|[\\/])(node_modules|\.git|\.next|dist|coverage|__pycache__)([\\/]|$)/.test(s),
    });

    const before = await indexRepo(work);
    const beforeFingerprints = fingerprintsOf(before.issues);

    const fixerIds = opts.rule ? fixersForRule(opts.rule).map((f) => f.id) : undefined;
    if (opts.rule && fixerIds!.length === 0) {
      throw new Error(
        `No fixer handles rule "${opts.rule}". Known: ${FIXERS.flatMap((f) => f.handles).join(", ")}`
      );
    }

    const scope =
      opts.file !== undefined || fixerIds !== undefined
        ? {
            ...(opts.file !== undefined ? { file: opts.file } : {}),
            ...(fixerIds !== undefined ? { fixerIds } : {}),
          }
        : undefined;
    const { edits, changed } = applyFixes(work, scope);

    if (edits.length === 0) {
      return {
        editCount: 0,
        filesChanged: 0,
        scoreBefore: before.score,
        scoreAfter: before.score,
        issuesBefore: before.issues.length,
        issuesAfter: before.issues.length,
        record: null,
        diff: "",
        summary: "No auto-fixable findings — nothing to patch.",
      };
    }

    // ── The four gates (LLD §7.2). Gate 3 is the one this whole command exists for.
    const sandbox = createSandbox({ root: work });
    // Built through `candidateFor` so gate 1 receives the files that actually changed. A
    // hand-rolled `edits: []` makes syntaxGate return "passed — no files edited" without
    // parsing anything, which is a gate that reports success for doing nothing.
    const candidate = candidateFor(edits, opts.rule ? `cli:${opts.rule}` : "cli-batch");
    const gates: GateResult[] = [];

    gates.push(
      await syntaxGate(candidate, sandbox, parseCheck, async (abs) => readFileSync(abs, "utf8"))
    );
    gates.push(await typesGate(sandbox, () => hasTypeConfig(work)));
    gates.push(
      await testsGate(sandbox, {
        // Both true, and that is the entire point of the CLI. On the developer's own machine
        // the isolation call is theirs — SPIKES §2 — so there is no operator flag to consult.
        // `--verify` is how they make it.
        allowed: opts.verify,
        canIsolate: opts.verify,
        notAllowedReason: "not requested — pass --verify to run your test suite",
        detectRunner: () => detectTestRunner(work),
        timeoutMs: opts.testTimeout * 1000,
      })
    );
    gates.push(
      // Null target: a batch run genuinely cannot attribute an edit to one finding, so gate 4
      // verifies "no new findings" and does NOT claim a named finding is gone. `--rule` narrows
      // which fixers run but still does not identify a single finding.
      await reanalysisGate(candidate, beforeFingerprints, null, async () =>
        fingerprintsOf((await indexRepo(work)).issues)
      )
    );

    const record = buildRecord("cli", gates);
    const after = await indexRepo(work);

    return {
      editCount: edits.length,
      filesChanged: changed.size,
      scoreBefore: before.score,
      scoreAfter: after.score,
      issuesBefore: before.issues.length,
      issuesAfter: after.issues.length,
      record,
      diff: buildDiff(changed),
      summary: describeRecord(record),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * A unified diff the developer can pipe to `git apply`.
 *
 * Hand-built rather than shelled out to `git diff`: the temp copy is not a repository, and
 * `git init` + `add` + `diff` inside it to produce text is more moving parts than the format
 * needs. Emitted with `a/`/`b/` prefixes so `git apply -p1` (the default) works unmodified.
 *
 * EXACT, not derived. It is driven by the edit map `applyFixes` returns, so the diff shows the
 * edits the `VerificationRecord` describes. An earlier version compared before/after arrays and
 * inferred which lines moved, which is guessing back information the apply loop already had —
 * and a diff that disagrees with the record is worse than no diff.
 */
function buildDiff(changed: ReadonlyMap<string, FileChange>): string {
  const parts: string[] = [];
  for (const [rel, change] of changed) {
    parts.push(`--- a/${rel}`, `+++ b/${rel}`, ...hunks(change));
  }
  return parts.join("\n");
}

/**
 * One hunk per run of changed lines, with three lines of context.
 *
 * THE `+` START LINE IS NOT THE `-` START LINE. Each hunk's new-side line number must account
 * for lines that EARLIER hunks removed, tracked in `delta` below. Emitting the before-index on
 * both sides produces a diff that looks plausible, renders fine, and is rejected by
 * `git apply` with "patch does not apply" the moment a file has two hunks and the first one
 * deletes a line. Caught by piping the output through `git apply --check` rather than reading
 * it — a hand-built diff is only correct if git says so.
 */
function hunks({ before, edits }: FileChange): string[] {
  const touched = [...edits.keys()].sort((a, b) => a - b);
  if (touched.length === 0) return [];

  const CONTEXT = 3;
  const out: string[] = [];
  // `text.split("\n")` yields a PHANTOM trailing "" for any file ending in a newline — which
  // is almost every file. Emitting it as a context line makes the hunk claim one more line
  // than the file has, and git rejects the whole patch with "patch does not apply". The apply
  // loop keeps that element because it rejoins with "\n"; the diff must not.
  const lastReal = before.length - (before[before.length - 1] === "" ? 1 : 0);
  // Net lines removed by hunks already emitted for this file.
  let delta = 0;
  let i = 0;
  while (i < touched.length) {
    // Coalesce runs whose context windows would overlap, so adjacent edits share one hunk.
    let j = i;
    while (j + 1 < touched.length && touched[j + 1]! - touched[j]! <= CONTEXT * 2) j++;

    const start = Math.max(0, touched[i]! - CONTEXT);
    const end = Math.min(lastReal - 1, touched[j]! + CONTEXT);

    const body: string[] = [];
    let removed = 0;
    let added = 0;
    for (let k = start; k <= end; k++) {
      const line = before[k]!;
      if (!edits.has(k)) {
        body.push(` ${line}`);
        removed++;
        added++;
        continue;
      }
      body.push(`-${line}`);
      removed++;
      const replacement = edits.get(k)!;
      if (replacement !== null) {
        body.push(`+${replacement}`);
        added++;
      }
    }
    out.push(`@@ -${start + 1},${removed} +${start + 1 - delta},${added} @@`, ...body);
    delta += removed - added;
    i = j + 1;
  }
  return out;
}

export { buildDiff };
