import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import type { RepoDetail } from "../types";
import { cloneRepo, resolveLocalDir, indexRepo, cleanup } from "../indexer";
import { redactCredentials } from "@codegraph/vcs";
import { isGithubHost } from "@codegraph/vcs";
import { parseGithubRepo, getDefaultBranch, createPullRequest, GitHubApiError } from "@codegraph/vcs";
import { FIXERS } from "./fixers";
import type { ExecutionStep, FileEdit, FixResult, PRDraft } from "./executor-types";
import type { VerificationRecord } from "@codegraph/verify";
import { logger } from "@codegraph/observability";
import { fingerprint, normalizeSnippet } from "@codegraph/core-domain";
import {
  buildRecord,
  describeRecord,
  reanalysisGate,
  syntaxGate,
  testsGate,
  typesGate,
  type FixCandidate,
  type GateResult,
} from "@codegraph/verify";
import { canIsolateTests, createSandbox, detectTestRunner, hasTypeConfig } from "./sandbox";

const SKIP: Record<string, true> = {
  ".git": true, node_modules: true, dist: true, build: true, ".next": true,
  out: true, vendor: true, __pycache__: true, ".venv": true, venv: true, target: true, coverage: true,
};
const CODE: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true, ".py": true,
};
const MAX = 4000;

function walkCode(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const name of entries) {
      const full = path.join(cur, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue; // never follow a symlink out of the disposable sandbox root
      if (st.isDirectory()) {
        if (!SKIP[name] && !name.startsWith(".")) stack.push(full);
      } else if (st.isFile() && CODE[path.extname(name).toLowerCase()] && st.size < 400_000) {
        out.push(full);
      }
    }
  }
  return out;
}

// Diff builder: supports both deletions (after=null) and same-line
// replacements (after=<new content>). Fixers only ever delete or replace a
// whole line in place — never insert new lines or reorder existing ones —
// so hunk line-count bookkeeping only has to account for pure deletions.
function buildDiff(file: string, before: string[], edits: Map<number, string | null>): string {
  if (edits.size === 0) return "";
  const ctx = 3;
  const idxs = [...edits.keys()].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const i of idxs) {
    const last = groups[groups.length - 1];
    if (last && i - last[last.length - 1] <= ctx * 2) last.push(i);
    else groups.push([i]);
  }
  const lines: string[] = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  let lineDelta = 0; // cumulative (new - old) line count shift from prior hunks
  for (const g of groups) {
    const start = Math.max(0, g[0] - ctx);
    const end = Math.min(before.length - 1, g[g.length - 1] + ctx);
    const oldCount = end - start + 1;
    let removedCount = 0;
    const body: string[] = [];
    for (let i = start; i <= end; i++) {
      if (!edits.has(i)) {
        body.push(" " + before[i]);
        continue;
      }
      const after = edits.get(i)!;
      body.push("-" + before[i]);
      if (after !== null) body.push("+" + after);
      else removedCount++;
    }
    const newCount = oldCount - removedCount;
    const oldStart = start + 1;
    const newStart = start + 1 + lineDelta;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    lines.push(...body);
    lineDelta += newCount - oldCount;
  }
  return lines.join("\n");
}

const now = () => Date.now();

/**
 * M4 Remediation Executor: acquire → analyze → apply safe codemods →
 * re-index to VERIFY the Health Score improves → produce a git diff + PR draft.
 * Runs entirely in a disposable sandbox; the user's original source is never mutated.
 */
/**
 * Restrict a run to one finding (review C1).
 *
 * The whole point: without this, `executeFixes` walks every file and runs every fixer, so
 * clicking a P0 "untrusted input reaches eval()" finding returned a diff deleting
 * `console.log` in 27 unrelated files. A scope makes the diff answer the question the user
 * asked.
 *
 * It is a parameter on the existing function rather than a second implementation, because
 * every other phase — acquire, baseline, apply, diff, verify, publish — is identical. Only
 * the SELECTION differs, and a parallel copy of that pipeline would be two things to keep
 * correct.
 */
export interface FixScope {
  /** Repo-relative path. Nothing outside it is read or edited. */
  readonly file: string;
  /** Fixer ids permitted to run, from `fixersForRule(finding.rule_id)`. */
  readonly fixerIds: readonly string[];
  /**
   * The finding's fingerprint, handed to gate 4 as its target.
   *
   * This is what upgrades verification from "nothing new was introduced" to "THIS finding is
   * gone" — the strong claim the batch path cannot make because it cannot name a target.
   */
  readonly targetFingerprint: string;
}

export async function executeFixes(
  repo: RepoDetail,
  githubToken?: string,
  scope?: FixScope
): Promise<FixResult> {
  const steps: ExecutionStep[] = [];
  let n = 0;
  const rec = (phase: ExecutionStep["phase"], detail: string, ok: boolean, t0: number) =>
    steps.push({ step: ++n, phase, detail, ok, ms: now() - t0 });

  let work: string | null = null;
  let cleanupWork = false;
  try {
    // 1. acquire disposable sandbox (never touch the original local folder)
    let t = now();
    if (repo.sourceType === "git") {
      work = await cloneRepo(repo.url);
      cleanupWork = true;
      rec("acquire", `Cloned ${repo.url} to sandbox`, true, t);
    } else {
      const src = resolveLocalDir(repo.url);
      work = mkdtempSync(path.join(tmpdir(), "cg-fix-"));
      cpSync(src, work, { recursive: true, filter: (s) => !SKIP[path.basename(s)] });
      cleanupWork = true;
      rec("acquire", `Copied local folder to sandbox (original untouched)`, true, t);
    }

    // 2. analyze (before)
    t = now();
    const before = await indexRepo(work);
    rec("analyze", `Baseline Health Score ${before.score}, ${before.issues.length} issues`, true, t);

    // 3. apply fixers
    t = now();
    // Scoped runs read one file. Not an optimisation — reading the rest is what produced
    // edits nobody asked for.
    const files = scope
      ? [path.join(work, scope.file)].filter((f) => existsSync(f))
      : walkCode(work);
    const allEdits: FileEdit[] = [];
    const changed = new Map<string, { before: string[]; edits: Map<number, string | null> }>();
    for (const full of files) {
      const rel = path.relative(work, full).split(path.sep).join("/");
      const ext = path.extname(full).toLowerCase();
      let text: string;
      try { text = readFileSync(full, "utf8"); } catch { continue; }
      const original = text.split("\n");

      // Run every fixer independently against the pristine original lines
      // (never chained) so each fixer's reported `line` stays valid against
      // `original` for diffing — chaining would shift a later fixer's line
      // numbers by however many lines an earlier fixer deleted.
      const merged = new Map<number, string | null>(); // original line idx -> after (null = delete)
      const fileEdits: FileEdit[] = [];
      // Only the fixers that declare they handle this finding's rule (`Fixer.handles`).
      const applicable = scope ? FIXERS.filter((f) => scope.fixerIds.includes(f.id)) : FIXERS;
      for (const fx of applicable) {
        const res = fx.apply({ rel, ext, lines: original });
        for (const e of res.edits) {
          const idx = e.line - 1;
          if (merged.has(idx)) continue; // another fixer already claimed this line this pass
          merged.set(idx, e.after);
          fileEdits.push(e);
        }
      }

      if (fileEdits.length) {
        const finalLines: string[] = [];
        for (let i = 0; i < original.length; i++) {
          if (!merged.has(i)) { finalLines.push(original[i]); continue; }
          const after = merged.get(i)!;
          if (after !== null) finalLines.push(after); // replacement
          // else: deletion — line dropped entirely
        }
        writeFileSync(full, finalLines.join("\n"), "utf8");
        allEdits.push(...fileEdits);
        changed.set(rel, { before: original, edits: merged });
      }
    }
    rec("apply", `Applied ${allEdits.length} edit(s) across ${changed.size} file(s)`, true, t);

    if (allEdits.length === 0) {
      if (cleanupWork && work) cleanup(work);
      return {
        ok: true, applied: 0, filesChanged: 0, edits: [], scoreBefore: before.score, scoreAfter: before.score,
        issuesBefore: before.issues.length, issuesAfter: before.issues.length, verified: true, pr: null, steps,
        message: "No auto-fixable findings — nothing to patch.",
      };
    }

    // 4. verify — the four gates (LLD §7.2, review C3)
    //
    // This replaced `after.score >= before.score && after.issues.length <= before.issues.length`,
    // which graded a fix by the metric it was built to move. Two ways that said yes when the
    // honest answer was no: an unrelated improvement in the same re-index masked a fix that
    // changed nothing, and a fix trading its target for a worse finding still passed.
    t = now();
    // `work` is `string | null` in the declaration above and non-null by here, but a real
    // check beats an assertion: if a future edit reorders the acquire step, this fails loudly
    // at the top of verification instead of handing gates a sandbox rooted at "null".
    if (!work) throw new Error("verification requires a sandbox; no workspace was acquired");
    const tree = work;
    const sandbox = createSandbox({ root: tree });
    const beforeFingerprints = fingerprintsOf(before.issues);
    // One id per run. Review C4's publish step keys on this, so it has to be stable across
    // the record and the draft rather than regenerated per consumer.
    const candidateId = `${repo.id}:${Date.now()}`;
    // A scoped run names its target, so gate 4 makes the strong claim. The unscoped batch
    // path passes null because it genuinely cannot attribute an edit to a finding — an
    // earlier version picked the highest-severity issue as a stand-in and the gate correctly
    // rejected it, since the fixers handle debug output, TODO markers and empty catches and
    // a security finding at the top of the list was never going to disappear.
    const targetFingerprint = scope?.targetFingerprint ?? null;

    const gates: GateResult[] = [];
    const candidate = candidateFor(allEdits, scope);

    gates.push(
      await syntaxGate(candidate, sandbox, parseCheck, async (abs) => readFileSync(abs, "utf8"))
    );
    gates.push(await typesGate(sandbox, () => hasTypeConfig(tree)));
    gates.push(
      await testsGate(sandbox, {
        allowed: canIsolateTests(),
        canIsolate: canIsolateTests(),
        detectRunner: () => detectTestRunner(tree),
      })
    );

    // Gate 4 re-indexes once and reuses that result for the score fields below, so the
    // patched tree is analysed exactly once rather than once per consumer.
    let after = before;
    gates.push(
      await reanalysisGate(candidate, beforeFingerprints, targetFingerprint, async () => {
        after = await indexRepo(tree);
        return fingerprintsOf(after.issues);
      })
    );

    const record = buildRecord(candidateId, gates);
    const verified = record.verified;
    rec("verify", describeRecord(record), verified, t);

    // 5. diff
    t = now();
    const diffParts: string[] = [];
    for (const [rel, c] of changed) diffParts.push(buildDiff(rel, c.before, c.edits));
    const diff = diffParts.filter(Boolean).join("\n");
    rec("diff", `Generated unified diff (${diff.split("\n").length} lines)`, true, t);

    // 6. record + PR draft
    t = now();
    let pr = verified ? buildPR(repo, before.score, after.score, allEdits, changed.size, diff, record) : null;
    
    if (pr && githubToken && repo.sourceType === "git" && isGithubHost(repo.url) && work) {
      try {
        const wd = work;
        const runGit = async (args: string[]) => exec("git", args, { cwd: wd });
        await runGit(["checkout", "-b", pr.branch]);
        await runGit(["config", "user.name", "CodeGraph Agent"]);
        await runGit(["config", "user.email", "agent@codegraph.dev"]);
        await runGit(["add", "."]);
        await runGit(["commit", "-m", pr.title + "\n\n" + pr.body]);
        
        const parsed = parseGithubRepo(repo.url);
        if (!parsed) throw new Error("Could not parse owner/repo from the remote URL");
        const { owner, repo: name } = parsed;

        // Resolve the REAL default branch before pushing anything. Doing it
        // first means a repo we can't read (bad token, renamed repo) fails
        // before we mutate the user's remote, not after.
        const base = await getDefaultBranch(owner, name, githubToken);

        const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${name}.git`;
        await runGit(["remote", "set-url", "origin", remoteUrl]);
        await runGit(["push", "-u", "origin", pr.branch]);

        // From here the user's remote HAS been mutated. If PR creation now
        // fails we must say so precisely — the old code reported success
        // regardless, leaving a pushed branch and no PR with no indication.
        try {
          const created = await createPullRequest({
            owner, repo: name, token: githubToken,
            title: pr.title, body: pr.body, head: pr.branch, base,
          });
          pr = { ...pr, url: created.url, number: created.number, base };
          rec("record", `Pushed ${pr.branch} and opened PR #${created.number} against ${base}`, true, t);
        } catch (prErr) {
          const detail = prErr instanceof GitHubApiError
            ? `${prErr.status} ${prErr.message}`
            : redactCredentials(prErr instanceof Error ? prErr.message : String(prErr));
          pr = { ...pr, base, pushed: true };
          rec(
            "record",
            `Pushed branch ${pr.branch}, but opening the PR failed (${detail}). ` +
              `The branch exists on the remote — open the PR manually or delete it.`,
            false,
            t,
          );
        }
      } catch (err) {
        // F017: execFile rejections embed the full argv — including the
        // token-bearing remoteUrl set via `git remote set-url` above — in
        // `.message`/`.cmd`. Redact before it ever reaches a log line.
        const safeErr = err instanceof Error ? redactCredentials(err.message) : redactCredentials(String(err));
        logger.warn("Failed to open PR", { err: safeErr });
        rec("record", "Failed to push or open PR", false, t);
      }
    } else {
      rec("record", pr ? "Assembled PR draft + execution record" : "Skipped PR (verification failed)", true, t);
    }

    return {
      ok: true,
      applied: allEdits.length,
      filesChanged: changed.size,
      edits: allEdits.slice(0, 200),
      scoreBefore: before.score,
      scoreAfter: after.score,
      issuesBefore: before.issues.length,
      issuesAfter: after.issues.length,
      verified,
      verification: record,
      pr,
      steps,
      message: verified
        ? `Verified: ${allEdits.length} fixes applied, Health Score ${before.score} → ${after.score}, issues ${before.issues.length} → ${after.issues.length}.`
        : "Fixes applied but verification failed (score regressed) — PR withheld.",
    };
  } catch (e) {
    const msg = redactCredentials(e instanceof Error ? e.message : String(e));
    rec("record", `Executor error: ${msg}`, false, now());
    return {
      ok: false, applied: 0, filesChanged: 0, edits: [], scoreBefore: repo.score ?? 0, scoreAfter: repo.score ?? 0,
      issuesBefore: 0, issuesAfter: 0, verified: false, pr: null, steps, message: msg,
    };
  } finally {
    if (cleanupWork && work) cleanup(work);
  }
}

function buildPR(
  repo: RepoDetail,
  scoreBefore: number,
  scoreAfter: number,
  edits: FileEdit[],
  filesChanged: number,
  diff: string,
  record: VerificationRecord
): PRDraft {
  const byFixer = new Map<string, number>();
  for (const e of edits) byFixer.set(e.fixer, (byFixer.get(e.fixer) || 0) + 1);
  const bullets = [...byFixer.entries()].map(([f, c]) => `- \`${f}\`: ${c} edit(s)`).join("\n");
  const body = [
    `## Automated remediation by CodeGraph`,
    ``,
    // The claim is now generated from the record instead of asserted. It previously read
    // "verified by re-indexing", which a reader hears as "the tests were run" — and for a
    // `partial` record they were not. Review C3.
    `This PR applies **safe, deterministic fixes** identified by the CodeGraph agent swarm.`,
    ``,
    `### Verification`,
    ``,
    describeRecord(record),
    ``,
    // Gate-by-gate, so a reviewer can see which evidence exists rather than trusting a word.
    `| Gate | Result | Detail |`,
    `|---|---|---|`,
    ...record.gates.map(
      (g) => `| \`${g.gate}\` | ${g.status} | ${(g.reason ?? "").replace(/\|/g, "\\|")} |`
    ),
    ``,
    record.level === "partial"
      ? `> **No test suite ran for this fix.** The changes re-parse cleanly and the target finding is gone, but this is not test-backed. See \`CG_ALLOW_TEST_VERIFICATION\`.`
      : `> The project's own test suite ran and passed against these changes.`,
    ``,
    `**Health Score:** ${scoreBefore} → **${scoreAfter}**  ·  **Files changed:** ${filesChanged}  ·  **Edits:** ${edits.length}`,
    ``,
    `### Changes`,
    bullets,
    ``,
    `### Verification`,
    `- Re-indexed the patched tree; Health Score did not regress and issue count did not increase.`,
    `- All edits are whole-line removals of leftover debug statements (no behavioral change in production paths).`,
    ``,
    `> Generated by CodeGraph M4 Remediation Executor. Review before merging.`,
  ].join("\n");
  return {
    title: `chore: remove leftover debug output (CodeGraph, +${scoreAfter - scoreBefore} health)`,
    body,
    branch: `codegraph/auto-remediation`,
    diff,
  };
}

/**
 * Fingerprint a v1 issue the same way `persistence` does, so before/after sets are
 * comparable (migration 003, LLD §2.1).
 *
 * GRANULARITY LIMIT, and it changes what gate 4 can prove. v1 stores no snippet, so the
 * fingerprint is rule+FILE — every occurrence of one rule in one file collapses to a single
 * identity (measured during the P1-8 backfill and recorded in REVIEW_2026-07-29 §P1-8).
 *
 * The consequence is specific: gate 4 asks "is this fingerprint gone", so for a file with
 * two `console.log`s it passes only when BOTH are removed. That is stricter than "was this
 * occurrence fixed", never weaker, so it cannot manufacture a false pass — a fix that
 * removes one of two occurrences reports NOT verified, which is a false negative and the
 * safe direction to be wrong in. Per-occurrence identity needs the multi-factor
 * fingerprint from LLD §2.1, which is P5's structural-hash work.
 */
function fingerprintsOf(issues: readonly { title?: string; file?: string }[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const issue of issues) out.add(fingerprintOf(issue));
  return out;
}

function fingerprintOf(issue: { title?: string; file?: string }): string {
  const title = issue.title ?? "Unknown finding";
  const ruleId = `legacy/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"}`;
  const parts = (issue.file ?? "").split("/");
  const scope = parts[parts.length - 1] || (issue.file ?? "");
  return fingerprint({ ruleId, scope, normalizedSnippet: normalizeSnippet("") });
}

/**
 * Adapt the applied edits into a `FixCandidate` for the gates.
 *
 * INTERIM. Review C1 wants one candidate per finding, carrying its `findingId`, produced by
 * a provider bound to the rule it fixes (`FixProvider.handles`). Today's executor collects
 * edits repo-wide and cannot say which finding each one served, so this reports the batch as
 * a single candidate. Gates 1-3 are unaffected — they judge the patched tree, not the
 * attribution. Gate 4 is weakened to "the batch removed this finding", which is why the
 * per-finding `/fix` route is the next piece of P3 rather than a later nicety.
 */
function candidateFor(edits: readonly FileEdit[], scope?: FixScope): FixCandidate {
  const files = [...new Set(edits.map((e) => e.file))];
  return {
    findingId: "" as FixCandidate["findingId"],
    // Naming the actual providers for a scoped run, so the record does not describe a
    // targeted single-finding fix as `legacy-batch`. The batch path keeps that name because
    // it IS a batch.
    providerId: scope ? scope.fixerIds.join("+") : "legacy-batch",
    edits: files.map((file) => ({
      range: { file, startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
      newText: "",
    })),
    explanation: `${edits.length} deterministic edit(s) across ${files.length} file(s)`,
    confidence: 1,
  };
}

/**
 * Gate 1's parse check.
 *
 * Deliberately NOT a full parser. `@codegraph/verify` takes `parse` injected precisely so it
 * depends on no language plugin, and the plugin that would answer properly arrives in P5
 * (`lang-typescript` at `full` tier). What is checkable now without one is balance of
 * brackets and quotes, which is exactly the damage a line-deleting fixer does — review B1
 * shipped an edit that left `if (x)` with no body.
 *
 * It is honest about being weak: it reports `ok` for anything it cannot disprove, so it
 * catches the destructive case and never blocks a valid fix it does not understand.
 */
function parseCheck(file: string, text: string): { ok: boolean; error?: string } {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return { ok: true };

  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth < 0) return { ok: false, error: "unbalanced closing bracket" };
    }
  }

  if (depth !== 0) return { ok: false, error: `unbalanced brackets (depth ${depth})` };
  if (inString) return { ok: false, error: "unterminated string literal" };
  if (inBlockComment) return { ok: false, error: "unterminated block comment" };
  return { ok: true };
}
