"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Loader2, Gauge, Boxes, Network, FileWarning, Share2, LayoutGrid, CircleDot, BrainCircuit, Bot, Code2, AlertTriangle } from "lucide-react";
import { fetchRepo } from "@/lib/api";
import type { RepoDetail, Dimension } from "@/lib/types";
import { DIMENSION_META } from "@/lib/types";
import { NetworkView } from "@/components/NetworkView";
import { CirclePackView } from "@/components/CirclePackView";
import { ArchitectureView } from "@/components/ArchitectureView";
import { CodeIntelPanel } from "@/components/CodeIntelPanel";
import { AgentSwarm } from "@/components/AgentSwarm";
import { CodeEditor } from "@/components/CodeEditor";

type ViewMode = "architecture" | "pack" | "network" | "intel" | "agents" | "editor";

const SEV_COLOR: Record<number, string> = {
  5: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  4: "text-orange-400 bg-orange-500/10 border-orange-500/20",
  3: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  2: "text-yellow-300 bg-yellow-500/10 border-yellow-500/20",
  1: "text-gray-400 bg-white/5 border-white/10",
};

function scoreColor(s: number): string {
  if (s >= 80) return "#34d399";
  if (s >= 60) return "#fbbf24";
  return "#fb7185";
}

export default function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [view, setView] = useState<ViewMode>("architecture");
  // Tabs a user has opened at least once during this page visit. A visited tab
  // stays mounted (just hidden via CSS) instead of unmounting on tab switch —
  // otherwise AgentSwarm's report, CodeIntel's search/prompt, and any unsaved
  // Editor buffers reset every time you switch away and back.
  const [visited, setVisited] = useState<Set<ViewMode>>(new Set(["architecture"]));

  useEffect(() => {
    fetchRepo(id).then(setRepo).catch(() => setNotFound(true));
  }, [id]);

  function selectView(v: ViewMode) {
    setView(v);
    setVisited((prev) => (prev.has(v) ? prev : new Set(prev).add(v)));
  }

  if (notFound) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center text-gray-400">
        Repository not found. <Link href="/dashboard" className="text-purple-400">Back to dashboard</Link>
      </div>
    );
  }
  if (!repo) {
    return (
      <div className="flex items-center gap-2 text-gray-500 py-24 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading report…
      </div>
    );
  }

  const overall = repo.score ?? 0;
  const wide = view === "editor";

  return (
    <div className={`mx-auto px-6 py-12 ${wide ? "max-w-[1600px]" : "max-w-5xl"}`}>
      <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-white mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Dashboard
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4 mb-10">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">{repo.name}</h1>
          {repo.sourceType === "git" ? (
            <a href={repo.url} target="_blank" rel="noreferrer" className="text-sm text-gray-500 font-mono hover:text-purple-300">{repo.url}</a>
          ) : (
            <span className="text-sm text-gray-500 font-mono">local · {repo.url}</span>
          )}
        </div>
      </div>

      {/* Score + graph stats */}
      <div className="grid lg:grid-cols-5 gap-6 mb-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="lg:col-span-2 rounded-2xl border border-white/10 bg-gradient-to-br from-purple-500/10 to-blue-500/5 p-8 flex flex-col items-center justify-center text-center"
        >
          <Gauge className="w-7 h-7 text-purple-300 mb-3" />
          <div className="text-6xl font-bold tracking-tight" style={{ color: scoreColor(overall) }}>
            {overall}<span className="text-2xl text-gray-600">/100</span>
          </div>
          <div className="mt-2 text-sm text-gray-400">Codebase Health Score</div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }}
          className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          <Stat icon={<Network className="w-4 h-4 text-cyan-400" />} label="Graph nodes" value={repo.graphStats?.nodes || 0} />
          <Stat icon={<Boxes className="w-4 h-4 text-purple-400" />} label="Graph edges" value={repo.graphStats?.edges || 0} />
          <Stat label="Files" value={repo.graphStats?.files || 0} />
          <Stat label="Lines of code" value={repo.loc} />
          <Stat label="Directories" value={repo.graphStats?.dirs || 0} />
          <Stat label="Dependencies" value={repo.graphStats?.dependencies || 0} />
          <Stat label="Issues found" value={repo.issues.length} />
          <Stat label="Languages" value={repo.languages?.length || 0} />
        </motion.div>
      </div>

      {repo.symbolGraph?.truncated && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200">
            <span className="font-semibold">Partial results.</span> This repository has more symbols than the {repo.symbolGraph.stats.symbols.toLocaleString()}-symbol
            analysis cap — the health score, agent findings, and code graph below only reflect the first {repo.symbolGraph.stats.symbols.toLocaleString()} symbols indexed, not the whole codebase.
          </p>
        </div>
      )}

      {/* Codebase visualization (3 views) */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Share2 className="w-4 h-4 text-cyan-400" /> Codebase intelligence
          </h2>
          <div className="inline-flex flex-wrap rounded-lg border border-white/10 bg-[#0a0a0a] p-1 text-sm">
            <ViewTab active={view === "architecture"} onClick={() => selectView("architecture")} icon={<LayoutGrid className="w-4 h-4" />} label="Architecture" />
            <ViewTab active={view === "pack"} onClick={() => selectView("pack")} icon={<CircleDot className="w-4 h-4" />} label="Circle pack" />
            <ViewTab active={view === "network"} onClick={() => selectView("network")} icon={<Network className="w-4 h-4" />} label="Network" />
            <ViewTab active={view === "intel"} onClick={() => selectView("intel")} icon={<BrainCircuit className="w-4 h-4" />} label="Code Intel" />
            <ViewTab active={view === "agents"} onClick={() => selectView("agents")} icon={<Bot className="w-4 h-4" />} label="Agents" />
            <ViewTab active={view === "editor"} onClick={() => selectView("editor")} icon={<Code2 className="w-4 h-4" />} label="Editor" />
          </div>
        </div>

        {/* Each visited tab stays mounted (hidden via CSS, not unmounted) so
            in-flight state — agent reports, code-intel search, editor tabs —
            survives switching away and back. */}
        {visited.has("architecture") && (
          <div className={view === "architecture" ? "" : "hidden"}>
            {repo.modules && repo.modules.nodes.length > 0
              ? <ArchitectureView modules={repo.modules} />
              : <Empty msg="No module structure detected." />}
          </div>
        )}

        {visited.has("pack") && (
          <div className={view === "pack" ? "" : "hidden"}>
            {repo.tree && repo.tree.children && repo.tree.children.length > 0
              ? <CirclePackView tree={repo.tree} />
              : <Empty msg="No file tree available." />}
          </div>
        )}

        {visited.has("network") && (
          <div className={view === "network" ? "" : "hidden"}>
            {repo.viz && repo.viz.nodes.length > 0
              ? <NetworkView graph={repo.viz} />
              : <Empty msg="No import network for this repository." />}
          </div>
        )}

        {visited.has("intel") && (
          <div className={view === "intel" ? "" : "hidden"}>
            <CodeIntelPanel repoId={repo.id} graph={repo.symbolGraph} />
          </div>
        )}

        {visited.has("agents") && (
          <div className={view === "agents" ? "" : "hidden"}>
            <AgentSwarm repoId={repo.id} />
          </div>
        )}

        {visited.has("editor") && (
          <div className={view === "editor" ? "" : "hidden"}>
            {repo.hasWorkspace
              ? <CodeEditor key={repo.id} repo={repo} visible={view === "editor"} />
              : <Empty msg="No live workspace for this repository yet — re-index it to enable the built-in editor." />}
          </div>
        )}
      </div>

      {view !== "editor" && (
        <>
          {/* Dimensions */}
          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6 mb-6">
            <h2 className="text-sm font-semibold text-white mb-4">Score breakdown</h2>
            <div className="space-y-4">
              {repo.dimensions.map((d, i) => {
                const meta = DIMENSION_META[d.dimension as Dimension];
                return (
                  <div key={d.dimension}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300">{meta.label} <span className="text-gray-600 text-xs">· {d.issueCount} issues · weight {Math.round(meta.weight * 100)}%</span></span>
                      <span className="font-mono text-gray-400">{d.score}</span>
                    </div>
                    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }} animate={{ width: `${d.score}%` }}
                        transition={{ duration: 0.7, delay: i * 0.05 }}
                        className="h-full rounded-full" style={{ background: meta.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Languages */}
          {repo.languages && repo.languages.length > 0 && (
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6 mb-6">
              <h2 className="text-sm font-semibold text-white mb-4">Languages</h2>
              <div className="flex flex-wrap gap-2">
                {repo.languages.slice(0, 3).map((l: any) => (
                  <span key={l.language} className="text-xs px-3 py-1 rounded-full border border-white/10 text-gray-300">
                    {l.language} <span className="text-gray-600">· {l.loc.toLocaleString()} LOC</span>
                  </span>
                ))}
                {repo.languages.length > 3 && (
                  <span className="text-xs px-3 py-1 rounded-full border border-white/5 text-gray-500">
                    +{repo.languages.length - 3} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Top issues */}
          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6">
            <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
              <FileWarning className="w-4 h-4 text-amber-400" /> Top issues by impact
            </h2>
            <p className="text-xs text-gray-600 mb-4">Ranked by severity × blast radius (graph fan-in).</p>
            {repo.issues.length === 0 ? (
              <p className="text-sm text-emerald-400">No issues detected. Clean codebase.</p>
            ) : (
              <div className="divide-y divide-white/5">
                {repo.issues.slice(0, 40).map((iss) => (
                  <div key={iss.id} className="py-3 flex items-start gap-3">
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${SEV_COLOR[iss.severity]}`}>
                      S{iss.severity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-200">{iss.title}</div>
                      <div className="text-xs text-gray-600 font-mono truncate">
                        {iss.file}{iss.line > 1 ? `:${iss.line}` : ""}
                      </div>
                    </div>
                    <span className="text-[10px] text-gray-600 shrink-0 mt-1">×{iss.blastRadius} blast</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">{icon}{label}</div>
      <div className="text-xl font-bold text-white">{value.toLocaleString()}</div>
    </div>
  );
}


function ViewTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-medium transition-colors ${active ? "bg-white text-black" : "text-gray-400 hover:text-white"}`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <p className="text-sm text-gray-600 border border-dashed border-white/10 rounded-xl p-10 text-center">{msg}</p>
  );
}
