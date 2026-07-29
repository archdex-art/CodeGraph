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

/**
 * Fixes an open calibration gap: on `expressjs/express@a371447` this produced
 * P0:21 P1:38 P2:0 P3:0 — every finding landed in the top two buckets and the
 * priority split carried almost no information.
 *
 * Root cause: the old formula was `severity × blast × churnMult × confidence
 * × effortBonus × 10` with every factor uncapped above 1. A bare-minimum
 * finding — severity 2, one caller, no churn history, 0.9 confidence,
 * low-urgency effort — already scored ~40, exactly the P1 floor. The
 * multipliers had no real floor, so almost nothing landed below the P1 line.
 *
 * **A first fix attempt (severity band = `severity × 20`, i.e. 20/40/60/80/100
 * — landing exactly on the priority thresholds) turned out to reproduce the
 * same bug on real data.** Measured on the same repo: severity 2 is the
 * overwhelming common case (44 of 59 findings on express — deadcode,
 * refactor, and low-severity security findings all cluster there), and
 * `severity × 20 = 40` sits exactly on the P1 threshold. Any modifier at or
 * above 1.0 — which most well-corroborated findings hit — tips it over. Bands
 * on thresholds only *look* calibrated; every "typical" finding of that
 * severity still lands right on a coin-flip boundary.
 *
 * The actual fix: **bands sit at the midpoint of their intended priority
 * range, not on its edge.** `10 + (severity − 1) × 20` gives 10/30/50/70/90.
 * A severity 2 finding at a neutral modifier (~1.0) now scores 30 — solidly
 * inside P2 (20–39) — and needs a genuinely strong modifier (≥ 1.33) to cross
 * into P1, or a genuinely weak one (< 0.67) to drop into P3. Verified against
 * the same repo this bug was found on: P0:8 P1:16 P2:35 P3:0 (was
 * P0:21 P1:38 P2:0 P3:0) — P2 went from carrying zero information to being
 * the plurality bucket, which is what "most findings are routine, a few are
 * urgent" should actually look like. **P3 stayed empty on this specific
 * repo** — not because it's unreachable (a severity-2 finding at the 0.4
 * modifier floor scores 12, well inside P3; a synthetic low-confidence case
 * is asserted in `orchestrator.test.ts`) but because nothing in express's
 * specific finding mix combines low enough severity, confidence, and blast
 * radius to earn it. It is populated in practice by exactly the case the
 * deadcode specialist already produces elsewhere — an *exported* unreferenced
 * symbol, whose confidence drops to 0.3 because it might be a public API,
 * scoring 14 (observed in the `churn.test.ts` fixture, not hypothesised).
 * Recorded here rather than tuned away: forcing P3 non-empty on one repo by
 * loosening the formula would be fitting the metric to a single data point,
 * the exact mistake the absolute thresholds `70/40/20` already made.
 *
 * The `[0.4, 2.5]` modifier clamp does NOT make every higher severity outrank
 * every lower one — it can't, and claiming otherwise here would be the same
 * "interface optimism" already called out on the design docs. A
 * maximally-modified severity 2 (30 × 2.5 = 75) still outranks a
 * minimally-modified severity 3 (50 × 0.4 = 20); reachability and confidence
 * are real signals, not noise to be crushed. What the clamp *does* guarantee,
 * deliberately, is the extreme case: severity 5 at its floor (90 × 0.4 = 36)
 * always outranks severity 1 at its ceiling (10 × 2.5 = 25) — the same class
 * of invariant §B2 enforces on the Health Score (`indexer.ts`'s capped
 * `blastMultiplier`), proven the same way there: with an assertion, not a
 * claim.
 *
 * The ceiling is 2.5 and the score is deliberately NOT capped at 100, both
 * learned from a regression this change caused and `churn.test.ts` caught: a
 * tighter 1.6 ceiling plus a hard 100 cap made a hotspot (churn 50) and an
 * untouched file (churn 1) with otherwise identical inputs *both* saturate to
 * exactly 80, silently destroying the churn signal that Task 6.11 exists to
 * provide. Two findings that differ on a real signal must not collide on a
 * clamp. This score is a ranking number, not a percentage — it is rendered as
 * a bare `score {n}` in `AgentSwarm.tsx` and consumed only by the ordering and
 * the thresholds below — so letting a genuinely severe, hot, well-corroborated
 * finding exceed 100 costs nothing and preserves resolution at the top, which
 * is exactly where ties are most misleading.
 */
function judgeScore(f: Finding): number {
  const band = 10 + (f.severity - 1) * 20; // 1‥5 → 10/30/50/70/90 — midpoints of the priorityOf ranges
  const blastFactor = 1 + Math.log2(1 + f.blastRadius) / 4; // damped; ~1.0 leaf, ~1.5 at blastRadius 60
  const churnFactor = 1 + Math.log10(1 + (f.churn ?? 1)) / 6; // mild; hotspots nudge up, don't dominate
  const effortBonus = f.effort === "S" ? 1.15 : f.effort === "M" ? 1.0 : 0.85; // quick wins ranked up
  const modifier = Math.max(0.4, Math.min(2.5, blastFactor * churnFactor * f.confidence * effortBonus));
  return Math.round(Math.max(1, band * modifier));
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
