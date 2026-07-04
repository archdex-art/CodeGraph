import type { RepoDetail } from "../types";
import { QueryEngine } from "../codeintel/query";
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

  const projectedScore = projectScore(repo.score ?? 0, buckets);

  return {
    generatedAt: Date.now(),
    repoScore: repo.score ?? 0,
    projectedScore,
    totalFindings: all.length,
    agents: reports,
    buckets,
    topFindings: all.slice(0, 60),
    summary: planSummary(all, buckets, repo.score ?? 0, projectedScore),
  };
}

function critique(findings: Finding[]): Finding[] {
  const byLocus = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.title}`;
    const l = byLocus.get(key) || [];
    l.push(f);
    byLocus.set(key, l);
  }
  const out: Finding[] = [];
  for (const group of byLocus.values()) {
    // merge exact dupes: keep highest severity, union corroborators
    const primary = group.reduce((a, b) => (b.severity > a.severity ? b : a));
    const others = group.filter((g) => g.agent !== primary.agent).map((g) => g.agent);
    if (others.length) {
      primary.corroboratedBy = [...new Set(others)];
      primary.confidence = Math.min(1, primary.confidence + 0.15 * others.length);
    }
    out.push(primary);
  }
  return out;
}

function judgeScore(f: Finding): number {
  // Weighted by severity, graph blast radius (log-damped), and confidence.
  const blast = 1 + Math.log2(1 + f.blastRadius);
  const effortBonus = f.effort === "S" ? 1.15 : f.effort === "M" ? 1.0 : 0.85; // quick wins ranked up
  return Math.round(f.severity * blast * f.confidence * effortBonus * 10);
}

function priorityOf(f: Finding): Priority {
  const s = f.score || 0;
  if (f.agent === "security" && f.severity >= 4) return "P0";
  if (s >= 70) return "P0";
  if (s >= 40) return "P1";
  if (s >= 20) return "P2";
  return "P3";
}

// Estimate score recovery if P0+P1 are fixed (bounded, diminishing).
function projectScore(current: number, buckets: Record<Priority, Finding[]>): number {
  const impactful = buckets.P0.length * 2.2 + buckets.P1.length * 1.1;
  const recovery = Math.min(100 - current, Math.round(impactful));
  return Math.min(100, current + recovery);
}

function summarize(agent: string, findings: Finding[]): string {
  if (!findings.length) return "No issues found.";
  const worst = findings.reduce((a, b) => (b.severity > a.severity ? b : a));
  return `${findings.length} finding(s); worst: ${worst.title}.`;
}

function planSummary(all: Finding[], buckets: Record<Priority, Finding[]>, cur: number, proj: number): string {
  if (!all.length) return "No actionable findings \u2014 the codebase is clean across all specialists.";
  const parts = [
    `${all.length} findings across ${new Set(all.map((f) => f.agent)).size} specialists.`,
    `${buckets.P0.length} critical (P0), ${buckets.P1.length} high (P1).`,
  ];
  if (proj > cur) parts.push(`Addressing P0+P1 projects Health Score ${cur} \u2192 ${proj}.`);
  const top = all[0];
  if (top) parts.push(`Highest impact: "${top.title}" (${top.file || "arch"}).`);
  return parts.join(" ");
}
