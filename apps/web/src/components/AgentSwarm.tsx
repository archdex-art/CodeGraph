"use client";

import { useState } from "react";
import { Bot, Loader2, Play, ShieldAlert, Gauge, Wrench, Skull, Package, Network, FlaskConical, ChevronRight, TrendingUp, GitPullRequest, Copy, Check } from "lucide-react";
import { runAgents, runFix } from "@/lib/api";
import type { AgentId, Finding, Priority, RemediationPlan } from "@/lib/agents/types";
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

export function AgentSwarm({ repoId }: { repoId: string }) {
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Priority | "all">("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setPlan(await runAgents(repoId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

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

          <RemediationExecutor repoId={repoId} />

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

          <div className="space-y-sm">
            {findings.map((f) => (
              <FindingRow key={f.id} f={f} open={expanded === f.id} onToggle={() => setExpanded(expanded === f.id ? null : f.id)} />
            ))}
            {findings.length === 0 && <p className="text-meta text-[var(--accent-text)] text-center py-lg">No findings in this bucket.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function FindingRow({ f, open, onToggle }: { f: Finding; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-hover)]">
      <button onClick={onToggle} className="w-full flex items-center gap-md px-md py-md text-left hover:bg-[var(--surface-hover)]">
        <span className={`text-micro font-mono px-xs py-hair rounded-xs border shrink-0 ${PRIO_STYLE[f.priority!]}`}>{f.priority}</span>
        {AGENT_ICON[f.agent]}
        <div className="min-w-0 flex-1">
          <div className="text-meta text-[var(--text-primary)] truncate">{f.title}</div>
          <div className="text-micro text-[var(--text-muted)] font-mono truncate">
            {f.file ? `${f.file}${f.line > 1 ? ":" + f.line : ""}` : "architecture"}
            {f.corroboratedBy?.length ? ` · corroborated by ${f.corroboratedBy.join(", ")}` : ""}
          </div>
        </div>
        <span className="text-micro text-[var(--text-secondary)] shrink-0">S{f.severity} · ×{f.blastRadius} · {f.effort}</span>
        <ChevronRight className={`w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
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
            <span>effort {f.effort === "S" ? "small" : f.effort === "M" ? "medium" : "large"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RemediationExecutor({ repoId }: { repoId: string }) {
  const [res, setRes] = useState<FixResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"diff" | "body" | null>(null);
  const [token, setToken] = useState("");

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setRes(await runFix(repoId, token.trim() || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  const copy = (what: "diff" | "body", text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="rounded-2xl border border-[var(--accent-text)]/20 bg-gradient-to-br from-[var(--accent-text)]/[0.06] to-transparent p-md">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <div>
          <h3 className="text-h3 font-semibold text-[var(--text-primary)] flex items-center gap-sm"><GitPullRequest className="w-4 h-4 text-[var(--accent-text)]" /> Remediation Executor (M4)</h3>
          <p className="text-meta text-[var(--text-secondary)] mt-2xs">Applies safe deterministic fixes in a sandbox, re-indexes to verify the score improves, and generates a PR-ready diff. Your source is never modified.</p>
        </div>
        <div className="flex items-center gap-sm">
          <input 
            type="password" 
            placeholder="GitHub PAT (optional)" 
            value={token} 
            onChange={e => setToken(e.target.value)} 
            className="rounded-lg bg-[var(--surface-2)] border border-[var(--line)] px-sm py-sm text-meta text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--signal-600)] w-48"
          />
          <button onClick={run} disabled={loading} className="flex items-center gap-sm bg-[var(--signal-500)] text-[var(--accent-on-fill)] hover:bg-[var(--signal-400)] px-lg py-sm rounded-lg font-semibold disabled:opacity-40 shrink-0">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
            {loading ? "Executing…" : "Generate verified fix PR"}
          </button>
        </div>
      </div>

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

          {/* verdict — `full` vs `partial` must look different (PLAN.md §4) */}
          <VerificationVerdict
            record={res.verification}
            message={res.message}
            scoreBefore={res.scoreBefore}
            scoreAfter={res.scoreAfter}
            showScores={res.applied > 0}
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
                  <span className="text-meta text-[var(--text-secondary)]">{res.filesChanged} file(s) · {res.applied} edit(s)</span>
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
