"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Play, ShieldAlert, Gauge, Wrench, Skull, Package, Network, FlaskConical, ChevronRight, TrendingUp, GitPullRequest, Copy, Check } from "lucide-react";
import { runAgents, runFix } from "@/lib/api";
import { once, useSharedState, writeState } from "@/lib/ui-state";
import { autoFixable, editorHref, findingLocation } from "@/lib/findings";
import { plural } from "@/lib/plural";
import type { AgentId, Finding, Priority, RemediationPlan } from "@/lib/agents/types";
import type { Issue } from "@codegraph/analysis-model";
import { FIXERS } from "@codegraph/remediate-engine/fixers";
import type { FixResult } from "@/lib/agents/executor-types";
import { VerificationVerdict } from "./VerificationVerdict";

const AGENT_ICON: Record<AgentId, React.ReactNode> = {
  security: <ShieldAlert className="w-4 h-4 text-[var(--coral-text)]" />,
  performance: <Gauge className="w-4 h-4 text-[var(--amber-text)]" />,
  refactor: <Wrench className="w-4 h-4 text-[var(--violet-text)]" />,
  deadcode: <Skull className="w-4 h-4 text-[var(--text-muted)]" />,
  dependency: <Package className="w-4 h-4 text-[var(--accent-text)]" />,
  architecture: <Network className="w-4 h-4 text-[var(--violet-text)]" />,
  test: <FlaskConical className="w-4 h-4 text-[var(--text-secondary)]" />,
};

const PRIO_STYLE: Record<Priority, string> = {
  P0: "text-[var(--coral-text)] bg-[var(--coral-500)]/15 border-[var(--coral-500)]/30",
  P1: "text-[var(--coral-text)] bg-[var(--coral-500)]/[0.07] border-[var(--coral-500)]/20",
  P2: "text-[var(--amber-text)] bg-[var(--amber-400)]/10 border-[var(--amber-400)]/20",
  P3: "text-[var(--text-secondary)] bg-[var(--surface-active)] border-[var(--line)]",
};

/**
 * Every row carries a four-part shorthand — `P1 · S3 · ×12 · M` — and the page shipped with
 * nothing anywhere that decoded it. A reader who has not read `orchestrator.ts` cannot tell
 * whether `×12` is good or bad, or what separates P1 from P2.
 *
 * Both halves of the fix are here on purpose. The visible legend above the list is what makes
 * the shorthand learnable at all, because a tooltip is only found by someone who already
 * suspects there is something to hover; the per-row titles are what answer the question at the
 * row you are actually looking at, with that row's own numbers in it. Priority wording states
 * the thresholds `priorityOf` applies, so the chip and the code cannot drift into disagreeing.
 */
const PRIO_TITLE: Record<Priority, string> = {
  P0: "Priority 0 — fix first. Score 70 or above, or any security finding at severity 4+. Counted in the projected Health Score.",
  P1: "Priority 1 — high. Score 40 to 69. Counted in the projected Health Score.",
  P2: "Priority 2 — routine. Score 20 to 39.",
  P3: "Priority 3 — lowest. Score below 20.",
};

/** The word the expanded row already uses for an effort letter. One vocabulary, two places. */
const EFFORT_WORD: Record<Finding["effort"], string> = { S: "small", M: "medium", L: "large" };

/**
 * Swarm state is keyed by repository and lives outside the component.
 *
 * Sections are routes now, so this component unmounts the moment you open the
 * editor — with local `useState` that discarded a finished plan and orphaned a
 * run that was still executing. The run therefore writes to the shared store and
 * `once` makes it idempotent, so navigating away mid-run and back re-attaches to
 * the same request and still shows its result.
 */
const key = (repoId: string, part: string) => `swarm:${repoId}:${part}`;

function startSwarm(repoId: string): void {
  void once(key(repoId, "run"), async () => {
    writeState(key(repoId, "loading"), true);
    writeState<string | null>(key(repoId, "error"), null);
    try {
      writeState<RemediationPlan | null>(key(repoId, "plan"), await runAgents(repoId));
    } catch (e) {
      writeState<string | null>(key(repoId, "error"), e instanceof Error ? e.message : "Failed");
    } finally {
      writeState(key(repoId, "loading"), false);
    }
  });
}

export function AgentSwarm({ repoId, hasWorkspace, issues }: { repoId: string; hasWorkspace: boolean; issues: readonly Issue[] }) {
  const [plan] = useSharedState<RemediationPlan | null>(key(repoId, "plan"), null);
  const [loading] = useSharedState(key(repoId, "loading"), false);
  const [error] = useSharedState<string | null>(key(repoId, "error"), null);
  const [filter, setFilter] = useSharedState<Priority | "all">(key(repoId, "filter"), "all");
  const [expanded, setExpanded] = useSharedState<string | null>(key(repoId, "expanded"), null);

  const run = () => startSwarm(repoId);

  const findings = plan
    ? filter === "all"
      ? plan.topFindings
      : plan.buckets[filter]
    : [];

  return (
    <div className="space-y-md">
      {!plan && (
        <div className="rounded-xl border border-[var(--violet-500)]/20 bg-gradient-to-br from-[var(--violet-500)]/[0.06] to-transparent p-xl text-center">
          <div className="w-14 h-14 rounded-2xl bg-[var(--surface-active)] border border-[var(--line)] flex items-center justify-center mx-auto mb-md">
            <Bot className="w-7 h-7 text-[var(--violet-text)]" />
          </div>
          <h3 className="text-h3 font-semibold text-[var(--text-primary)] mb-2xs">Autonomous Agent Swarm</h3>
          <p className="text-body text-[var(--text-secondary)] max-w-measure mx-auto mb-lg">
            Seven specialists (Security, Performance, Refactor, Dead code, Dependency, Architecture, Test)
            analyze the knowledge graph in parallel, cross-corroborate, and a judge produces a ranked
            remediation plan with a projected Health Score.
          </p>
          <button onClick={run} disabled={loading} className="inline-flex items-center gap-sm bg-[var(--signal-500)] text-[var(--accent-on-fill)] hover:bg-[var(--signal-400)] px-lg py-md rounded-full font-semibold disabled:opacity-40">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? "Agents working…" : "Run agent swarm"}
          </button>
          {error && <p className="mt-md text-meta text-[var(--coral-text)]">{error}</p>}
        </div>
      )}

      {plan && (
        <>
          {/* Summary + projected score */}
          <div className="grid lg:grid-cols-3 gap-md">
            <div className="rounded-2xl border border-[var(--line)] bg-gradient-to-br from-[var(--violet-500)]/10 to-transparent p-lg flex flex-col items-center justify-center text-center">
              <div className="flex items-center gap-md">
                <div className="text-h1 font-bold text-[var(--text-primary)]">{plan.repoScore}</div>
                <TrendingUp className="w-5 h-5 text-[var(--accent-text)]" />
                <div className="text-h1 font-bold text-[var(--accent-text)]">{plan.projectedScore}</div>
              </div>
              <div className="text-micro text-[var(--text-secondary)] mt-sm">Health Score · projected after P0+P1</div>
            </div>
            <div className="lg:col-span-2 rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-hover)] p-lg">
              <p className="text-meta text-[var(--text-primary)]">{plan.summary}</p>
              <div className="flex gap-md mt-md text-micro">
                {(["P0", "P1", "P2", "P3"] as Priority[]).map((p) => (
                  <span key={p} className={`px-sm py-hair rounded-xs border ${PRIO_STYLE[p]}`}>{p}: {plan.buckets[p].length}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Agent reports */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-md">
            {plan.agents.map((a) => (
              <div key={a.agent} className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-hover)] p-md">
                <div className="flex items-center gap-sm mb-2xs">
                  {AGENT_ICON[a.agent]}
                  <span className="text-meta font-medium text-[var(--text-primary)]">{a.label}</span>
                  <span className="ml-auto text-micro text-[var(--text-secondary)]">{a.findings}</span>
                </div>
                <p className="text-micro text-[var(--text-secondary)]">{a.summary}</p>
              </div>
            ))}
          </div>

          <RemediationExecutor repoId={repoId} issues={issues} />

          {/* Filter + findings */}
          <div className="flex items-center gap-sm">
            <span className="text-micro text-[var(--text-secondary)]">Filter:</span>
            {(["all", "P0", "P1", "P2", "P3"] as const).map((p) => (
              <button key={p} onClick={() => setFilter(p)} className={`text-meta px-sm py-2xs rounded-md border transition-colors ${filter === p ? "bg-[var(--signal-500)] text-[var(--accent-on-fill)] border-[var(--signal-500)]" : "border-[var(--line)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                {p === "all" ? "All" : p}
              </button>
            ))}
            <button onClick={run} disabled={loading} className="ml-auto text-meta flex items-center gap-2xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} re-run
            </button>
          </div>

          {/* The legend, not a tooltip, is what makes the row shorthand readable on first
              sight — see PRIO_TITLE. Deliberately one line: it sits above every finding on
              the page and has to cost a glance, not a paragraph. */}
          <p className="text-micro text-[var(--text-muted)]">
            Each row reads priority · severity · blast radius · effort. P0–P3 is the fix order,
            S1–S5 the severity, ×n the blast radius — how many symbols reach this finding through
            the graph — and S/M/L the size of the remediation.
          </p>

          <div className="space-y-sm">
            {findings.map((f) => (
              <FindingRow
                key={f.id}
                f={f}
                open={expanded === f.id}
                onToggle={() => setExpanded(expanded === f.id ? null : f.id)}
                repoId={repoId}
                hasWorkspace={hasWorkspace}
              />
            ))}
            {findings.length === 0 && <p className="text-meta text-[var(--accent-text)] text-center py-lg">No findings in this bucket.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function FindingRow({
  f,
  open,
  onToggle,
  repoId,
  hasWorkspace,
}: {
  f: Finding;
  open: boolean;
  onToggle: () => void;
  repoId: string;
  hasWorkspace: boolean;
}) {
  const where = f.file ? findingLocation(f) : "architecture";
  const badgeTitle =
    `Severity ${f.severity} of 5 · blast radius ${f.blastRadius}: ` +
    `${plural(f.blastRadius, "symbol")} reach this one through the graph · ` +
    `effort ${EFFORT_WORD[f.effort]}`;
  return (
    <div className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-hover)]">
      {/* Stretched toggle rather than a wrapping button, for the same reason the fleet rows
          on the dashboard use one: the location has to be a link to the file it names, and an
          anchor inside a button is invalid markup whose click lands on the wrong control —
          which is exactly what this row did, silently expanding instead of opening the file.

          The content layer is inert so the whole header still toggles. The two elements that
          own a behaviour of their own take pointer events back: the link, and the badges,
          whose tooltips a browser will not show through `pointer-events: none`. */}
      <div className="relative">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} finding: ${f.title}`}
          className="absolute inset-0 z-0 cursor-pointer rounded-xl transition-colors hover:bg-[var(--surface-active)]"
        />
        <div className="pointer-events-none relative z-[1] flex items-center gap-md px-md py-md text-left">
          <span
            title={PRIO_TITLE[f.priority!]}
            className={`pointer-events-auto text-micro font-mono px-xs py-hair rounded-xs border shrink-0 ${PRIO_STYLE[f.priority!]}`}
          >
            {f.priority}
          </span>
          {AGENT_ICON[f.agent]}
          <div className="min-w-0 flex-1">
            <div className="text-meta text-[var(--text-primary)] truncate">{f.title}</div>
            <div className="text-micro text-[var(--text-muted)] font-mono truncate">
              {f.file && hasWorkspace ? (
                <Link
                  href={editorHref(repoId, f.file, f.line)}
                  onClick={(e) => e.stopPropagation()}
                  title={`Open ${where} in the editor`}
                  className="pointer-events-auto relative z-10 cursor-pointer underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--accent-text)]"
                >
                  {where}
                </Link>
              ) : (
                where
              )}
              {f.corroboratedBy?.length ? ` · corroborated by ${f.corroboratedBy.join(", ")}` : ""}
            </div>
          </div>
          <span title={badgeTitle} className="pointer-events-auto text-micro text-[var(--text-secondary)] shrink-0">
            S{f.severity} · ×{f.blastRadius} · {f.effort}
          </span>
          <ChevronRight className={`w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        </div>
      </div>
      {open && (
        <div className="px-md pb-md pt-2xs space-y-sm border-t border-[var(--line-soft)]">
          <p className="text-meta text-[var(--text-secondary)]">{f.detail}</p>
          <div className="rounded-lg bg-[var(--accent-text)]/[0.06] border border-[var(--accent-text)]/15 p-md">
            <div className="text-micro uppercase tracking-wide text-[var(--accent-text)] mb-2xs">Suggested fix</div>
            <p className="text-meta text-[var(--text-primary)]">{f.suggestedFix}</p>
          </div>
          <div className="flex gap-md text-micro text-[var(--text-muted)]">
            <span>confidence {Math.round(f.confidence * 100)}%</span>
            <span>score {f.score}</span>
            <span>effort {EFFORT_WORD[f.effort]}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The fix run outlives the section too — it clones, patches, re-indexes and
 * verifies, which is minutes of work that used to be thrown away by a single
 * click on another section. The PAT is the one piece deliberately NOT stored:
 * it is a credential, and it should not sit in a module map after you leave.
 */
/**
 * The remediation panel.
 *
 * The button used to be offered identically on every repository and, on one with nothing it
 * could fix, ran four seconds to say so. `autoFixable` answers that before the click, so a
 * run is only offered when there is something to run — and when there is, the label says how
 * much, which is also the honest ceiling on what the diff will contain.
 */
function RemediationExecutor({ repoId, issues }: { repoId: string; issues: readonly Issue[] }) {
  const [res] = useSharedState<FixResult | null>(key(repoId, "fix"), null);
  const [loading] = useSharedState(key(repoId, "fixLoading"), false);
  const [error] = useSharedState<string | null>(key(repoId, "fixError"), null);
  const [copied, setCopied] = useState<"diff" | "body" | null>(null);
  const [token, setToken] = useState("");
  const copyTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const fixable = useMemo(() => autoFixable(issues), [issues]);

  // The 1.5s "copied" reset would otherwise fire into an unmounted component
  // when you copy a diff and immediately navigate.
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  function run() {
    const pat = token.trim() || undefined;
    void once(key(repoId, "fixRun"), async () => {
      writeState(key(repoId, "fixLoading"), true);
      writeState<string | null>(key(repoId, "fixError"), null);
      try {
        writeState<FixResult | null>(key(repoId, "fix"), await runFix(repoId, pat));
      } catch (e) {
        writeState<string | null>(key(repoId, "fixError"), e instanceof Error ? e.message : "Failed");
      } finally {
        writeState(key(repoId, "fixLoading"), false);
      }
    });
  }

  const copy = (what: "diff" | "body", text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(what);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="rounded-2xl border border-[var(--accent-text)]/20 bg-gradient-to-br from-[var(--accent-text)]/[0.06] to-transparent p-md">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <div>
          <h3 className="text-h3 font-semibold text-[var(--text-primary)] flex items-center gap-sm"><GitPullRequest className="w-4 h-4 text-[var(--accent-text)]" /> Remediation Executor</h3>
          <p className="text-meta text-[var(--text-secondary)] mt-2xs">Applies safe deterministic fixes in a sandbox, re-indexes to verify the score improves, and generates a PR-ready diff. Your source is never modified.</p>
        </div>
        <div className="flex items-center gap-sm">
          {/* The PAT only matters for a run that will produce a branch, so it is not drawn
              beside a button that has nothing to push. */}
          {fixable.length > 0 && (
            <input
              type="password"
              placeholder="GitHub PAT (optional)"
              value={token}
              onChange={e => setToken(e.target.value)}
              className="rounded-lg bg-[var(--surface-2)] border border-[var(--line)] px-sm py-sm text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--signal-600)] w-48"
            />
          )}
          <button
            onClick={run}
            disabled={loading || fixable.length === 0}
            data-testid="run-fix"
            title={fixable.length === 0 ? "No finding in this repository is claimed by a fix provider." : undefined}
            className="flex items-center gap-sm bg-[var(--signal-500)] text-[var(--accent-on-fill)] hover:bg-[var(--signal-400)] px-lg py-sm rounded-lg font-semibold disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
            {loading
              ? "Executing…"
              : fixable.length === 0
                ? "No auto-fixable findings"
                : `Generate verified fix for ${plural(fixable.length, "finding")}`}
          </button>
        </div>
      </div>

      {/*
        * Said once, plainly, instead of after a four-second run that looks like a failure.
        * Naming the count of providers is the actionable half: the gap is coverage, not a
        * problem with this repository.
        */}
      {fixable.length === 0 && (
        <p className="mt-md text-meta text-[var(--text-secondary)]" data-testid="no-fixable-note">
          Nothing here is auto-fixable. {plural(FIXERS.length, "fix provider")} {FIXERS.length === 1 ? "exists" : "exist"} so far, and no finding in this repository matches {FIXERS.length === 1 ? "it" : "any of them"}. Everything below is still real — it just needs a human.
        </p>
      )}

      {error && <p className="mt-md text-meta text-[var(--coral-text)]">{error}</p>}

      {res && (
        <div className="mt-md space-y-md">
          {/* execution steps */}
          <div className="flex flex-wrap gap-sm text-micro">
            {res.steps.map((s) => (
              <span key={s.step} className={`px-sm py-2xs rounded-xs border ${s.ok ? "border-[var(--line)] text-[var(--text-secondary)]" : "border-[var(--coral-500)]/30 text-[var(--coral-text)]"}`}>
                {s.phase} · {s.ms}ms
              </span>
            ))}
          </div>
          <VerificationVerdict
            record={res.verification}
            message={res.message}
            scoreBefore={res.scoreBefore}
            scoreAfter={res.scoreAfter}
            showScores={res.applied > 0}
            applied={res.applied}
          />

          {res.pr && (
            <>
              <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-inset)] p-md">
                <div className="flex items-center justify-between mb-2xs">
                  <span className="text-meta font-mono text-[var(--accent-text)]">{res.pr.branch}</span>
                  <button onClick={() => copy("body", res.pr!.body)} className="flex items-center gap-2xs text-micro text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    {copied === "body" ? <><Check className="w-3 h-3 text-[var(--accent-text)]" /> copied</> : <><Copy className="w-3 h-3" /> copy PR body</>}
                  </button>
                </div>
                <div className="text-meta text-[var(--text-primary)] font-medium">{res.pr.title}</div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2xs">
                  <span className="text-meta text-[var(--text-secondary)]">{plural(res.filesChanged, "file")} · {plural(res.applied, "edit")}</span>
                  <button onClick={() => copy("diff", res.pr!.diff)} className="flex items-center gap-2xs text-micro text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    {copied === "diff" ? <><Check className="w-3 h-3 text-[var(--accent-text)]" /> copied</> : <><Copy className="w-3 h-3" /> copy diff</>}
                  </button>
                </div>
                <pre className="text-meta bg-[var(--surface-inset)] rounded-lg p-md max-h-[340px] overflow-auto font-mono">{colorizeDiff(res.pr.diff)}</pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function colorizeDiff(diff: string): React.ReactNode {
  return diff.split("\n").map((line, i) => {
    let cls = "text-[var(--text-secondary)]";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-[var(--accent-text)]";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-[var(--coral-text)]";
    else if (line.startsWith("@@")) cls = "text-[var(--violet-text)]";
    else if (line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---")) cls = "text-[var(--text-muted)]";
    return <div key={i} className={cls}>{line || " "}</div>;
  });
}
