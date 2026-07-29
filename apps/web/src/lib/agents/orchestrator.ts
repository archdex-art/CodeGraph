import type { RepoDetail } from "../types";
import { QueryEngine } from "../codeintel/query";
import { scoreIssues } from "../indexer";
import type { AgentReport, Finding, Priority, RemediationPlan } from "./types";
import { SPECIALISTS, resetSeq, type AgentContext } from "./specialists";

/**
 * Agent swarm orchestration (deterministic, zero external API required).
 *
 *   plan → specialists run in parallel over shared graph memory
 *        → critic dedupes + cross-corroborates (agreement raises confidence)
 *        → judge scores (severity × blastRadius × confidence) + assigns priority
 *        → assemble a ranked remediation plan + projected score.
 *
 * This mirrors the "specialized agents collaborate, critique, and judge" model,
 * grounded in the codebase graph rather than free-form LLM guessing.
 */
export function runSwarm(repo: RepoDetail): RemediationPlan {
  resetSeq();
  const qe = new QueryEngine(repo.symbolGraph);
  const ctx: AgentContext = { repo, qe };

  // 1. Specialists (independent; safe to run together).
  const reports: AgentReport[] = [];
  let all: Finding[] = [];
  for (const s of SPECIALISTS) {
    let findings: Finding[] = [];
    try {
      findings = s.run(ctx);
    } catch {
      findings = [];
    }
    reports.push({
      agent: s.id,
      label: s.label,
      findings: findings.length,
      summary: summarize(s.id, findings),
    });
    all = all.concat(findings);
  }

  // 2. Critic: corroboration by (file:line) locus — multiple agents flagging the
  //    same spot increases confidence; identical duplicates are merged.
  all = critique(all);

  // 3. Judge: score + prioritize.
  for (const f of all) {
    f.score = judgeScore(f);
    f.priority = priorityOf(f);
  }
  all.sort((a, b) => (b.score || 0) - (a.score || 0));

  const buckets: Record<Priority, Finding[]> = { P0: [], P1: [], P2: [], P3: [] };
  for (const f of all) buckets[f.priority!].push(f);

  const projectedScore = projectScore(repo, buckets);

  return {
    generatedAt: Date.now(),
    repoScore: repo.score ?? 0,
    projectedScore,
    totalFindings: all.length,
    agents: reports,
    buckets,
    topFindings: all.slice(0, 60),
    summary: planSummary(all, buckets, repo.score ?? 0, projectedScore, repo.symbolGraph.truncated),
    truncated: repo.symbolGraph.truncated,
  };
}

function critique(findings: Finding[]): Finding[] {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const l = byFile.get(f.file) || [];
    l.push(f);
    byFile.set(f.file, l);
  }

  const out: Finding[] = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => a.line - b.line);
    let currentGroup: Finding[] = [];

    const flush = () => {
      if (!currentGroup.length) return;
      // merge dupes in group: keep highest severity, union corroborators
      const primary = currentGroup.reduce((a, b) => (b.severity > a.severity ? b : a));
      const others = currentGroup.filter((g) => g.agent !== primary.agent).map((g) => g.agent);
      if (others.length) {
        primary.corroboratedBy = [...new Set(others)];
        primary.confidence = Math.min(1, primary.confidence + 0.15 * others.length);
      }
      out.push(primary);
      currentGroup = [];
    };

    for (const f of list) {
      if (!currentGroup.length) {
        currentGroup.push(f);
      } else {
        const last = currentGroup[currentGroup.length - 1];
        if (Math.abs(f.line - last.line) <= 2) {
          currentGroup.push(f);
        } else {
          flush();
          currentGroup.push(f);
        }
      }
    }
    flush();
  }
  return out;
}

function judgeScore(f: Finding): number {
  // Weighted by severity, graph blast radius (log-damped), confidence, and churn.
  const blast = 1 + Math.log2(1 + f.blastRadius);
  const churnMult = 1 + Math.log10(1 + (f.churn ?? 1)); // hotspots rank higher
  const effortBonus = f.effort === "S" ? 1.15 : f.effort === "M" ? 1.0 : 0.85; // quick wins ranked up
  return Math.round(f.severity * blast * churnMult * f.confidence * effortBonus * 10);
}

function priorityOf(f: Finding): Priority {
  const s = f.score || 0;
  if (f.agent === "security" && f.severity >= 4) return "P0";
  if (s >= 70) return "P0";
  if (s >= 40) return "P1";
  if (s >= 20) return "P2";
  return "P3";
}

/**
 * Projected score if the P0 and P1 findings are fixed.
 *
 * Fixes review item C5. This used to be
 * `P0.length × 2.2 + P1.length × 1.1` — a linear guess over bucket counts,
 * presented in the UI and the README as a forecast of an exponential model over
 * penalty mass. It could not be right except by coincidence: it never looked at
 * severity, blast radius, or which dimension a finding belonged to, so two
 * findings with a 50× penalty difference moved it identically.
 *
 * Now it re-runs the real scorer (`scoreIssues`, the same function that produced
 * the current score) over the issues that would remain. That makes the number a
 * simulation rather than an estimate, and it moves automatically with any future
 * change to the score model instead of silently drifting away from it.
 *
 * Findings are matched to issues by `file:line`, which is sound because the
 * specialists derive their findings from `repo.issues` in the first place. A
 * finding with no corresponding issue — one a specialist inferred from graph
 * structure rather than from a rule hit — correctly moves the projection by
 * nothing: the Health Score is computed from issues, so fixing something that is
 * not one cannot change it. Overstating that was the bug.
 */
function projectScore(repo: RepoDetail, buckets: Record<Priority, Finding[]>): number {
  const targeted = new Set<string>();
  for (const f of [...buckets.P0, ...buckets.P1]) targeted.add(`${f.file}:${f.line}`);

  const remaining = repo.issues.filter((i) => !targeted.has(`${i.file}:${i.line}`));
  // Nothing matched: report the score unchanged rather than inventing movement.
  if (remaining.length === repo.issues.length) return repo.score ?? 0;

  const { overall } = scoreIssues(remaining, repo.loc);
  // The projection is a floor, not a promise: fixing findings cannot lower the
  // score, and clamping keeps a re-scored dimension from reading as a regression.
  return Math.max(repo.score ?? 0, Math.min(100, overall));
}

function summarize(agent: string, findings: Finding[]): string {
  if (!findings.length) return "No issues found.";
  const worst = findings.reduce((a, b) => (b.severity > a.severity ? b : a));
  return `${findings.length} finding(s); worst: ${worst.title}.`;
}

function planSummary(all: Finding[], buckets: Record<Priority, Finding[]>, cur: number, proj: number, truncated: boolean): string {
  const warn = truncated
    ? "Partial analysis (workspace exceeds the symbol cap; findings only cover the indexed subset). "
    : "";
  if (!all.length) return warn + "No actionable findings \u2014 the codebase is clean across all specialists.";
  const parts = [
    `${all.length} findings across ${new Set(all.map((f) => f.agent)).size} specialists.`,
    `${buckets.P0.length} critical (P0), ${buckets.P1.length} high (P1).`,
  ];
  if (proj > cur) parts.push(`Addressing P0+P1 projects Health Score ${cur} \u2192 ${proj}.`);
  const top = all[0];
  if (top) parts.push(`Highest impact: "${top.title}" (${top.file || "arch"}).`);
  return warn + parts.join(" ");
}
