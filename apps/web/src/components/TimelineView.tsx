"use client";

import { useEffect, useState, useRef } from "react";
import { Play, Pause, Loader2, ChevronLeft, ChevronRight, Info, FileText, X } from "lucide-react";
import { timelineMetadata, timelineSnapshot, timelineBuild, timelineCompare, gitDiffFiles, gitDiffCommits } from "@/lib/api";
import type { TimelineSnapshot, ArchitectureSnapshot, ArchitectureEvolution } from "@/lib/gitops/timelineApi";
import { CirclePackView } from "@/components/CirclePackView";

export function TimelineView({ repoId }: { repoId: string }) {
  const [snapshots, setSnapshots] = useState<TimelineSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentGraph, setCurrentGraph] = useState<ArchitectureSnapshot | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  
  // Comparison State
  const [compareBase, setCompareBase] = useState<string>("");
  const [compareHead, setCompareHead] = useState<string>("");
  const [comparisonEvolution, setComparisonEvolution] = useState<ArchitectureEvolution | null>(null);
  const [comparing, setComparing] = useState(false);
  const [changedFiles, setChangedFiles] = useState<Array<{ status: string, path: string }>>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiffText, setFileDiffText] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const playRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    loadMetadata();
    return () => pause();
  }, [repoId]);

  useEffect(() => {
    if (snapshots.length > 0) {
      loadSnapshot(snapshots[currentIndex].hash);
    }
  }, [currentIndex, snapshots]);

  async function loadMetadata() {
    setLoading(true);
    try {
      const data = await timelineMetadata(repoId, "everyCommit");
      setSnapshots(data);
      if (data.length > 0) {
        setCurrentIndex(data.length - 1); // default to latest
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function handleBuild() {
    setBuilding(true);
    try {
      await timelineBuild(repoId, "everyCommit");
      await loadMetadata();
    } catch (e) {
      console.error("Failed to build timeline", e);
    } finally {
      setBuilding(false);
    }
  }

  async function loadSnapshot(hash: string) {
    setGraphLoading(true);
    try {
      const snap = await timelineSnapshot(repoId, hash);
      setCurrentGraph(snap);
    } catch (e) {
      console.error(e);
    } finally {
      setGraphLoading(false);
    }
  }

  function togglePlay() {
    if (playing) {
      pause();
    } else {
      if (currentIndex >= snapshots.length - 1) {
        setCurrentIndex(0);
      }
      setPlaying(true);
      playRef.current = setInterval(() => {
        setCurrentIndex(prev => {
          if (prev >= snapshots.length - 1) {
            pause();
            return prev;
          }
          return prev + 1;
        });
      }, 3000); // 3 seconds per frame to allow graph loading
    }
  }

  function pause() {
    setPlaying(false);
    clearInterval(playRef.current);
    playRef.current = undefined;
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-400 py-12 justify-center"><Loader2 className="w-5 h-5 animate-spin"/> Loading timeline...</div>;
  }

  if (snapshots.length === 0) {
    return (
      <div className="border border-dashed border-white/10 rounded-xl p-12 text-center flex flex-col items-center">
        <h3 className="text-white font-medium mb-2">Timeline not built</h3>
        <p className="text-sm text-gray-400 mb-6 max-w-md">The historical architecture timeline needs to be extracted from Git and analyzed.</p>
        <button 
          onClick={handleBuild} 
          disabled={building}
          className="flex items-center gap-2 bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
        >
          {building ? <Loader2 className="w-4 h-4 animate-spin"/> : null}
          {building ? "Building Timeline (This may take a while)..." : "Build Timeline"}
        </button>
      </div>
    );
  }

  const currentMeta = snapshots[currentIndex];
  
  return (
    <>
      <div className="flex flex-col gap-6">
      {/* Metrics Row */}
      <div className="grid grid-cols-6 gap-4">
        <MetricCard label="Date" value={new Date(currentMeta.timestamp * 1000).toLocaleDateString()} />
        <MetricCard label="Commit" value={currentMeta.hash.substring(0, 7)} sub={currentMeta.author} />
        <MetricCard 
          label="Coupling" 
          value={currentGraph?.evolution ? `${(currentGraph.evolution.metrics.coupling * 100).toFixed(0)}%` : "-"} 
          info="The percentage of import statements that cross top-level directory boundaries. Lower is better (highly modular)."
        />
        <MetricCard 
          label="Arch Score" 
          value={currentGraph?.evolution ? currentGraph.evolution.metrics.architectureScore.toFixed(0) : "-"} 
          info="A 0-100 health score weighted by issue severity, blast radius (fan-in), and normalized by codebase size."
        />
        <MetricCard label="Total Files" value={currentGraph?.metrics?.fileCount ?? "-"} />
        <MetricCard label="LOC" value={currentGraph?.metrics?.loc ?? "-"} />
      </div>

      {/* Main View & Ledger Split */}
      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 relative min-h-[500px] border border-white/5 bg-[#0a0a0a] rounded-xl overflow-hidden p-4">
          {graphLoading && (
            <div className="absolute top-4 right-4 z-10 flex items-center gap-2 text-xs bg-black/50 backdrop-blur px-3 py-1.5 rounded-full text-gray-400">
              <Loader2 className="w-3 h-3 animate-spin"/> Loading snapshot...
            </div>
          )}
          
          {currentGraph?.result?.tree ? (
            <CirclePackView tree={currentGraph.result.tree} />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500">No tree data for this snapshot</div>
          )}
        </div>

        {/* Evolution Ledger */}
        <div className="col-span-1 border border-white/5 bg-[#0a0a0a] rounded-xl p-4 flex flex-col gap-4 overflow-y-auto max-h-[600px]">
          <h3 className="text-sm font-semibold text-white">Architecture Evolution</h3>
          
          {currentGraph?.evolution?.aiNarrative && (
            <div className="bg-purple-500/10 border border-purple-500/20 p-3 rounded-lg">
              <p className="text-xs text-purple-200 mb-2">{currentGraph.evolution.aiNarrative.reason}</p>
              <p className="text-xs text-purple-300 font-medium">💡 {currentGraph.evolution.aiNarrative.recommendation}</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h4 className="text-xs text-gray-500 uppercase tracking-wider">Events</h4>
            {currentGraph?.evolution?.events.map((e, i) => (
              <div key={i} className="bg-white/5 p-3 rounded-lg border border-white/5">
                <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded text-gray-300 mb-2 inline-block">{e.category}</span>
                <div className="text-sm text-gray-200 font-medium">{e.title}</div>
                <div className="text-xs text-gray-400 mt-1">{e.description}</div>
              </div>
            ))}
            {!currentGraph?.evolution?.events.length && (
              <div className="text-xs text-gray-500 italic">No significant events in this snapshot.</div>
            )}
          </div>
          
          <div className="flex flex-col gap-2 mt-2">
            <h4 className="text-xs text-gray-500 uppercase tracking-wider">Module Health</h4>
            {currentGraph?.evolution?.moduleHealth && Object.values(currentGraph.evolution.moduleHealth).slice(0, 5).map(m => (
              <div key={m.moduleId} className="flex items-center justify-between text-xs p-2 bg-white/5 rounded border border-white/5">
                <span className="text-gray-300 truncate max-w-[120px]" title={m.moduleId}>{m.moduleId}</span>
                <span className={`px-2 py-0.5 rounded ${m.healthScore > 80 ? 'text-green-400 bg-green-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                  {m.healthScore.toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Scrubber / Controls */}
      <div className="bg-[#111] border border-white/10 rounded-xl p-4 flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <button onClick={togglePlay} className="p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors">
            {playing ? <Pause className="w-4 h-4"/> : <Play className="w-4 h-4" fill="currentColor" />}
          </button>
          
          <select 
            value={currentIndex}
            onChange={(e) => {
              pause();
              setCurrentIndex(parseInt(e.target.value));
            }}
            className="flex-1 bg-black border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
          >
            {snapshots.map((snap, i) => (
              <option key={snap.hash} value={i}>
                {new Date(snap.timestamp * 1000).toLocaleDateString()} — {snap.hash.substring(0,7)}: {snap.message.substring(0, 50)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-between text-xs text-gray-500 font-mono">
          <span>{new Date(snapshots[0].timestamp * 1000).toLocaleDateString()}</span>
          <span className="text-gray-300 font-medium truncate max-w-[50%] text-center px-4">
            {currentMeta.message}
          </span>
          <span>{new Date(snapshots[snapshots.length - 1].timestamp * 1000).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Main View Issues */}
      {currentGraph?.result?.issues && currentGraph.result.issues.length > 0 && (
        <div className="bg-[#111] border border-white/10 rounded-xl p-6 mt-2">
          <h3 className="text-sm font-semibold text-white mb-4">Issues in this Snapshot ({currentGraph.result.issues.length})</h3>
          <div className="max-h-[300px] overflow-y-auto pr-2">
            {currentGraph.result.issues.map((iss: any, i: number) => (
              <IssueItem key={i} issue={iss} />
            ))}
          </div>
        </div>
      )}

      {/* Ad-Hoc Compare Section */}
      <div className="bg-[#111] border border-white/10 rounded-xl p-6 mt-4">
        <h3 className="text-lg font-semibold text-white mb-4">Ad-Hoc Architecture Diff</h3>
        <p className="text-sm text-gray-400 mb-6">Select any two commits to compare their architectural evolution.</p>
        
        <div className="flex items-end gap-4 mb-6">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Base Snapshot</label>
            <select 
              value={compareBase}
              onChange={e => setCompareBase(e.target.value)}
              className="w-full bg-black border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
            >
              <option value="">Select Base...</option>
              {snapshots.map(s => <option key={s.hash} value={s.hash}>{s.hash.substring(0,7)} — {s.message.substring(0, 50)}</option>)}
            </select>
          </div>
          
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Head Snapshot</label>
            <select 
              value={compareHead}
              onChange={e => setCompareHead(e.target.value)}
              className="w-full bg-black border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
            >
              <option value="">Select Head...</option>
              {snapshots.map(s => <option key={s.hash} value={s.hash}>{s.hash.substring(0,7)} — {s.message.substring(0, 50)}</option>)}
            </select>
          </div>
          
          <button 
            onClick={async () => {
              if (!compareBase || !compareHead) return;
              setComparing(true);
              try {
                const [evo, files] = await Promise.all([
                  timelineCompare(repoId, compareBase, compareHead),
                  gitDiffFiles(repoId, compareBase, compareHead)
                ]);
                setComparisonEvolution(evo);
                setChangedFiles(files);
              } catch (err) {
                console.error(err);
              } finally {
                setComparing(false);
              }
            }}
            disabled={comparing || !compareBase || !compareHead}
            className="bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {comparing ? <Loader2 className="w-4 h-4 animate-spin"/> : "Compare"}
          </button>
        </div>
        
        {comparisonEvolution && (
          <div className="flex flex-col gap-6 mt-6">
            <div className="grid grid-cols-3 gap-6 bg-[#0a0a0a] border border-white/5 rounded-xl p-4">
              <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto pr-2">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-2 z-10">
                  Evolution Events ({compareBase.substring(0,7)} → {compareHead.substring(0,7)})
                </h4>
                {comparisonEvolution.events.map((e, i) => (
                  <div key={i} className="bg-white/5 p-3 rounded-lg border border-white/5">
                    <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded text-gray-300 mb-2 inline-block">{e.category}</span>
                    <div className="text-sm text-gray-200 font-medium">{e.title}</div>
                    <div className="text-xs text-gray-400 mt-1">{e.description}</div>
                  </div>
                ))}
              </div>
              
              {/* Changed Files Column */}
              <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto pr-2">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-2 z-10">
                  Changed Files ({changedFiles.length})
                </h4>
                {changedFiles.length === 0 ? (
                  <div className="text-xs text-gray-500 italic">No files changed.</div>
                ) : (
                  changedFiles.map((file, i) => {
                    const parts = file.path.split('/');
                    const fileName = parts.pop() || file.path;
                    return (
                      <button 
                        key={i} 
                        onClick={async () => {
                          setSelectedFile(file.path);
                          setLoadingDiff(true);
                          try {
                            const text = await gitDiffCommits(repoId, compareBase, compareHead, file.path);
                            setFileDiffText(text);
                          } catch (err) {
                            setFileDiffText("Failed to load diff.");
                          } finally {
                            setLoadingDiff(false);
                          }
                        }}
                        className="flex items-center gap-3 bg-white/5 hover:bg-white/10 p-2 rounded-lg border border-transparent hover:border-white/10 text-left transition-colors w-full"
                      >
                        <span className={`text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded ${file.status === 'A' ? 'bg-green-500/20 text-green-400' : file.status === 'D' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {file.status}
                        </span>
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-sm font-medium text-gray-200 truncate">{fileName}</span>
                          <span className="text-[10px] text-gray-500 truncate font-mono mt-0.5">{file.path}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
              
              <div className="flex flex-col gap-4">
                <div>
                  <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Metrics Shift</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <MetricCard 
                      label="Arch Score" 
                      value={comparisonEvolution.metrics.architectureScore.toFixed(0)} 
                      sub={comparisonEvolution.baselineMetrics ? `${comparisonEvolution.baselineMetrics.architectureScore.toFixed(0)} → ${comparisonEvolution.metrics.architectureScore.toFixed(0)}` : undefined}
                      info="A 0-100 health score weighted by issue severity, blast radius (fan-in), and normalized by codebase size."
                    />
                    <MetricCard 
                      label="Coupling" 
                      value={`${(comparisonEvolution.metrics.coupling * 100).toFixed(0)}%`} 
                      sub={comparisonEvolution.baselineMetrics ? `${(comparisonEvolution.baselineMetrics.coupling * 100).toFixed(0)}% → ${(comparisonEvolution.metrics.coupling * 100).toFixed(0)}%` : undefined}
                      info="The percentage of import statements that cross top-level directory boundaries. Lower is better (highly modular)."
                    />
                  </div>
                </div>
                
                {comparisonEvolution.aiNarrative && (
                  <div className="bg-purple-500/10 border border-purple-500/20 p-3 rounded-lg">
                    <h4 className="text-xs text-purple-400 uppercase tracking-wider mb-2">AI Summary</h4>
                    <p className="text-xs text-purple-200 mb-2">{comparisonEvolution.aiNarrative.reason}</p>
                    <p className="text-xs text-purple-300 font-medium">💡 {comparisonEvolution.aiNarrative.recommendation}</p>
                  </div>
                )}
              </div>
            </div>
            
            {/* Issues Shift */}
            {(comparisonEvolution.issueDiff?.introduced?.length > 0 || comparisonEvolution.issueDiff?.resolved?.length > 0) && (
              <div className="grid grid-cols-2 gap-6 bg-[#0a0a0a] border border-white/5 rounded-xl p-4">
                <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-2">
                  <h4 className="text-xs text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-2 z-10">
                    Issues Introduced ({comparisonEvolution.issueDiff.introduced.length})
                  </h4>
                  {comparisonEvolution.issueDiff.introduced.length === 0 ? (
                    <div className="text-xs text-gray-500 italic">No new issues introduced.</div>
                  ) : (
                    comparisonEvolution.issueDiff.introduced.map((iss: any, i: number) => (
                      <IssueItem key={i} issue={iss} />
                    ))
                  )}
                </div>
                <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-2">
                  <h4 className="text-xs text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-2 z-10">
                    Issues Resolved ({comparisonEvolution.issueDiff.resolved.length})
                  </h4>
                  {comparisonEvolution.issueDiff.resolved.length === 0 ? (
                    <div className="text-xs text-gray-500 italic">No issues resolved.</div>
                  ) : (
                    comparisonEvolution.issueDiff.resolved.map((iss: any, i: number) => (
                      <IssueItem key={i} issue={iss} />
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>

      {/* File Diff Modal */}
      {selectedFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-white/5 bg-[#111]">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-purple-400" />
                <h3 className="text-sm font-mono text-gray-200">{selectedFile}</h3>
              </div>
              <button 
                onClick={() => { setSelectedFile(null); setFileDiffText(null); }}
                className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {loadingDiff ? (
                <div className="flex items-center justify-center h-full text-gray-500 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin"/> Loading diff...
                </div>
              ) : (
                <div className="text-xs font-mono text-gray-300 whitespace-pre-wrap flex flex-col w-full bg-[#050505] p-2 rounded-lg border border-white/5">
                  {!fileDiffText ? (
                    <span className="text-gray-500 italic">No changes visible.</span>
                  ) : (
                    fileDiffText.split("\n").map((line, i) => {
                      let lineClass = "px-4 py-0.5 w-full ";
                      if (line.startsWith("+") && !line.startsWith("+++")) {
                        lineClass += "bg-green-500/10 text-green-400";
                      } else if (line.startsWith("-") && !line.startsWith("---")) {
                        lineClass += "bg-red-500/10 text-red-400";
                      } else if (line.startsWith("@@")) {
                        lineClass += "bg-cyan-500/10 text-cyan-400 mt-2 mb-1 rounded";
                      } else if (line.startsWith("+++") || line.startsWith("---")) {
                        lineClass += "text-gray-500 font-bold bg-white/5";
                      } else {
                        lineClass += "text-gray-400";
                      }
                      return (
                        <span key={i} className={lineClass}>
                          {line || " "}
                        </span>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MetricCard({ label, value, sub, info }: { label: string, value: string | number, sub?: string, info?: string }) {
  return (
    <div className="bg-white/5 border border-white/10 p-4 rounded-xl flex flex-col">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs text-gray-400">{label}</span>
        {info && (
          <div className="group relative flex items-center">
            <Info className="w-3 h-3 text-gray-500 hover:text-gray-300 cursor-help" />
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 opacity-0 transition-opacity group-hover:opacity-100 z-50 bg-gray-900 border border-white/10 text-gray-300 text-xs rounded p-2 shadow-xl">
              {info}
            </div>
          </div>
        )}
      </div>
      <span className="text-xl font-medium text-white">{value}</span>
      {sub && <span className="text-xs text-gray-500 mt-1 truncate">{sub}</span>}
    </div>
  );
}

const SEV_COLOR: Record<number, string> = {
  5: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  4: "text-orange-400 bg-orange-500/10 border-orange-500/20",
  3: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  2: "text-yellow-300 bg-yellow-500/10 border-yellow-500/20",
  1: "text-gray-400 bg-white/5 border-white/10",
};

function IssueItem({ issue }: { issue: any }) {
  return (
    <div className="py-2 flex items-start gap-3 border-b border-white/5 last:border-0">
      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${SEV_COLOR[issue.severity] || SEV_COLOR[1]}`}>
        S{issue.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-200">{issue.title}</div>
        <div className="text-xs text-gray-500 font-mono truncate">{issue.file}:{issue.line}</div>
      </div>
    </div>
  );
}
