"use client";

import { useState } from "react";
import { Bot, Loader2, Play, ShieldAlert, Gauge, Wrench, Skull, Package, Network, FlaskConical, ChevronRight, TrendingUp, GitPullRequest, Copy, Check, ShieldCheck } from "lucide-react";
import { runAgents, runFix } from "@/lib/api";
import type { AgentId, Finding, Priority, RemediationPlan } from "@/lib/agents/types";
import type { FixResult } from "@/lib/agents/executor-types";

const AGENT_ICON: Record<AgentId, React.ReactNode> = {
  security: <ShieldAlert className="w-4 h-4 text-rose-400" />,
  performance: <Gauge className="w-4 h-4 text-amber-400" />,
  refactor: <Wrench className="w-4 h-4 text-purple-400" />,
  deadcode: <Skull className="w-4 h-4 text-gray-400" />,
  dependency: <Package className="w-4 h-4 text-emerald-400" />,
  architecture: <Network className="w-4 h-4 text-cyan-400" />,
  test: <FlaskConical className="w-4 h-4 text-blue-400" />,
};

const PRIO_STYLE: Record<Priority, string> = {
  P0: "text-rose-300 bg-rose-500/15 border-rose-500/30",
  P1: "text-orange-300 bg-orange-500/15 border-orange-500/30",
  P2: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  P3: "text-gray-400 bg-white/5 border-white/10",
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
    <div className="space-y-4">
      {!plan && (
        <div className="rounded-xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.06] to-transparent p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-4">
            <Bot className="w-7 h-7 text-purple-300" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-1">Autonomous Agent Swarm</h3>
          <p className="text-sm text-gray-400 max-w-lg mx-auto mb-5">
            Seven specialists (Security, Performance, Refactor, Dead code, Dependency, Architecture, Test)
            analyze the knowledge graph in parallel, cross-corroborate, and a judge produces a ranked
            remediation plan with a projected Health Score.
          </p>
          <button onClick={run} disabled={loading} className="inline-flex items-center gap-2 bg-white text-black px-6 py-3 rounded-full font-semibold hover:bg-gray-200 disabled:opacity-40">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? "Agents working…" : "Run agent swarm"}
          </button>
          {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}
        </div>
      )}

      {plan && (
        <>
          {/* Summary + projected score */}
          <div className="grid lg:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-purple-500/10 to-blue-500/5 p-5 flex flex-col items-center justify-center text-center">
              <div className="flex items-center gap-3">
                <div className="text-4xl font-bold text-white">{plan.repoScore}</div>
                <TrendingUp className="w-5 h-5 text-emerald-400" />
                <div className="text-4xl font-bold text-emerald-400">{plan.projectedScore}</div>
              </div>
              <div className="text-xs text-gray-500 mt-2">Health Score · projected after P0+P1</div>
            </div>
            <div className="lg:col-span-2 rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <p className="text-sm text-gray-300 leading-relaxed">{plan.summary}</p>
              <div className="flex gap-4 mt-3 text-xs">
                {(["P0", "P1", "P2", "P3"] as Priority[]).map((p) => (
                  <span key={p} className={`px-2 py-0.5 rounded border ${PRIO_STYLE[p]}`}>{p}: {plan.buckets[p].length}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Agent reports */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {plan.agents.map((a) => (
              <div key={a.agent} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 mb-1">
                  {AGENT_ICON[a.agent]}
                  <span className="text-sm font-medium text-white">{a.label}</span>
                  <span className="ml-auto text-xs text-gray-500">{a.findings}</span>
                </div>
                <p className="text-[11px] text-gray-500 leading-snug">{a.summary}</p>
              </div>
            ))}
          </div>

          <RemediationExecutor repoId={repoId} />

          {/* Filter + findings */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Filter:</span>
            {(["all", "P0", "P1", "P2", "P3"] as const).map((p) => (
              <button key={p} onClick={() => setFilter(p)} className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${filter === p ? "bg-white text-black border-white" : "border-white/10 text-gray-400 hover:text-white"}`}>
                {p === "all" ? "All" : p}
              </button>
            ))}
            <button onClick={run} disabled={loading} className="ml-auto text-xs flex items-center gap-1 text-gray-400 hover:text-white">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} re-run
            </button>
          </div>

          <div className="space-y-2">
            {findings.map((f) => (
              <FindingRow key={f.id} f={f} open={expanded === f.id} onToggle={() => setExpanded(expanded === f.id ? null : f.id)} />
            ))}
            {findings.length === 0 && <p className="text-sm text-emerald-400 text-center py-6">No findings in this bucket.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function FindingRow({ f, open, onToggle }: { f: Finding; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02]">
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02]">
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${PRIO_STYLE[f.priority!]}`}>{f.priority}</span>
        {AGENT_ICON[f.agent]}
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white truncate">{f.title}</div>
          <div className="text-[11px] text-gray-600 font-mono truncate">
            {f.file ? `${f.file}${f.line > 1 ? ":" + f.line : ""}` : "architecture"}
            {f.corroboratedBy?.length ? ` · corroborated by ${f.corroboratedBy.join(", ")}` : ""}
          </div>
        </div>
        <span className="text-[10px] text-gray-500 shrink-0">S{f.severity} · ×{f.blastRadius} · {f.effort}</span>
        <ChevronRight className={`w-4 h-4 text-gray-600 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-2 border-t border-white/5">
          <p className="text-xs text-gray-400">{f.detail}</p>
          <div className="rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15 p-3">
            <div className="text-[10px] uppercase tracking-wide text-emerald-400 mb-1">Suggested fix</div>
            <p className="text-xs text-gray-300">{f.suggestedFix}</p>
          </div>
          <div className="flex gap-4 text-[10px] text-gray-600">
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
    <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.06] to-transparent p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2"><GitPullRequest className="w-4 h-4 text-emerald-300" /> Remediation Executor (M4)</h3>
          <p className="text-xs text-gray-500 mt-0.5">Applies safe deterministic fixes in a sandbox, re-indexes to verify the score improves, and generates a PR-ready diff. Your source is never modified.</p>
        </div>
        <div className="flex items-center gap-2">
          <input 
            type="password" 
            placeholder="GitHub PAT (optional)" 
            value={token} 
            onChange={e => setToken(e.target.value)} 
            className="rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/50 w-48"
          />
          <button onClick={run} disabled={loading} className="flex items-center gap-2 bg-white text-black px-5 py-2.5 rounded-lg font-semibold hover:bg-gray-200 disabled:opacity-40 shrink-0">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
            {loading ? "Executing…" : "Generate verified fix PR"}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

      {res && (
        <div className="mt-4 space-y-3">
          {/* execution steps */}
          <div className="flex flex-wrap gap-2 text-[10px]">
            {res.steps.map((s) => (
              <span key={s.step} className={`px-2 py-1 rounded border ${s.ok ? "border-white/10 text-gray-400" : "border-rose-500/30 text-rose-300"}`}>
                {s.phase} · {s.ms}ms
              </span>
            ))}
          </div>

          {/* verdict */}
          <div className={`flex items-center gap-3 rounded-lg border p-3 ${res.verified ? "border-emerald-500/20 bg-emerald-500/[0.06]" : "border-amber-500/20 bg-amber-500/[0.06]"}`}>
            <ShieldCheck className={`w-5 h-5 ${res.verified ? "text-emerald-400" : "text-amber-400"}`} />
            <div className="text-sm text-gray-200">{res.message}</div>
            {res.applied > 0 && (
              <div className="ml-auto flex items-center gap-2 text-sm shrink-0">
                <span className="text-gray-400">{res.scoreBefore}</span>
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-emerald-400">{res.scoreAfter}</span>
              </div>
            )}
          </div>

          {res.pr && (
            <>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono text-emerald-300">{res.pr.branch}</span>
                  <button onClick={() => copy("body", res.pr!.body)} className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-white">
                    {copied === "body" ? <><Check className="w-3 h-3 text-emerald-400" /> copied</> : <><Copy className="w-3 h-3" /> copy PR body</>}
                  </button>
                </div>
                <div className="text-sm text-white font-medium">{res.pr.title}</div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">{res.filesChanged} file(s) · {res.applied} edit(s)</span>
                  <button onClick={() => copy("diff", res.pr!.diff)} className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-white">
                    {copied === "diff" ? <><Check className="w-3 h-3 text-emerald-400" /> copied</> : <><Copy className="w-3 h-3" /> copy diff</>}
                  </button>
                </div>
                <pre className="text-[11px] leading-relaxed bg-black/40 rounded-lg p-3 max-h-[340px] overflow-auto font-mono">{colorizeDiff(res.pr.diff)}</pre>
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
    let cls = "text-gray-400";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-emerald-400";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-rose-400";
    else if (line.startsWith("@@")) cls = "text-cyan-400";
    else if (line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---")) cls = "text-gray-500";
    return <div key={i} className={cls}>{line || " "}</div>;
  });
}
