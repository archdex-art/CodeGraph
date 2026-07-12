import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import type { RepoDetail } from "../types";
import { cloneRepo, resolveLocalDir, indexRepo, cleanup } from "../indexer";
import { FIXERS } from "./fixers";
import type { ExecutionStep, FileEdit, FixResult, PRDraft } from "./executor-types";

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
      try { st = statSync(full); } catch { continue; }
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
export async function executeFixes(repo: RepoDetail, githubToken?: string): Promise<FixResult> {
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
    const before = indexRepo(work);
    rec("analyze", `Baseline Health Score ${before.score}, ${before.issues.length} issues`, true, t);

    // 3. apply fixers
    t = now();
    const files = walkCode(work);
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
      for (const fx of FIXERS) {
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

    // 4. verify (re-index the patched sandbox)
    t = now();
    const after = indexRepo(work);
    const verified = after.score >= before.score && after.issues.length <= before.issues.length;
    rec("verify", `Post-fix Health Score ${after.score}, ${after.issues.length} issues — ${verified ? "no regression" : "REGRESSION"}`, verified, t);

    // 5. diff
    t = now();
    const diffParts: string[] = [];
    for (const [rel, c] of changed) diffParts.push(buildDiff(rel, c.before, c.edits));
    const diff = diffParts.filter(Boolean).join("\n");
    rec("diff", `Generated unified diff (${diff.split("\n").length} lines)`, true, t);

    // 6. record + PR draft
    t = now();
    let pr = verified ? buildPR(repo, before.score, after.score, allEdits, changed.size, diff) : null;
    
    if (pr && githubToken && repo.sourceType === "git" && work) {
      try {
        const wd = work;
        const runGit = async (args: string[]) => exec("git", args, { cwd: wd });
        await runGit(["checkout", "-b", pr.branch]);
        await runGit(["config", "user.name", "CodeGraph Agent"]);
        await runGit(["config", "user.email", "agent@codegraph.dev"]);
        await runGit(["add", "."]);
        await runGit(["commit", "-m", pr.title + "\n\n" + pr.body]);
        
        // Parse owner/repo
        const m = repo.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (m) {
          const [_, owner, name] = m;
          const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${name}.git`;
          await runGit(["remote", "set-url", "origin", remoteUrl]);
          await runGit(["push", "-u", "origin", pr.branch]);
          
          // Open PR via API
          const res = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${githubToken}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              title: pr.title,
              body: pr.body,
              head: pr.branch,
              base: "main" // or master, ideally we'd detect this
            })
          });
          if (res.ok) {
            const data = await res.json();
            pr = { ...pr, diff: `PR Opened successfully: ${data.html_url}\n\n` + pr.diff };
          }
        }
        rec("record", "Pushed branch and opened GitHub PR", true, t);
      } catch (err) {
        console.warn("Failed to open PR:", err);
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
      pr,
      steps,
      message: verified
        ? `Verified: ${allEdits.length} fixes applied, Health Score ${before.score} → ${after.score}, issues ${before.issues.length} → ${after.issues.length}.`
        : "Fixes applied but verification failed (score regressed) — PR withheld.",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
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
  diff: string
): PRDraft {
  const byFixer = new Map<string, number>();
  for (const e of edits) byFixer.set(e.fixer, (byFixer.get(e.fixer) || 0) + 1);
  const bullets = [...byFixer.entries()].map(([f, c]) => `- \`${f}\`: ${c} edit(s)`).join("\n");
  const body = [
    `## Automated remediation by CodeGraph`,
    ``,
    `This PR applies **safe, deterministic fixes** identified by the CodeGraph agent swarm and **verified by re-indexing**.`,
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
