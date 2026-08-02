"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { Play, Pause, Loader2, ChevronLeft, ChevronRight, Info, FileText, X } from "lucide-react";
import { logger } from "@codegraph/observability";
import { timelineMetadata, timelineSnapshot, timelineBuild, timelineCompare, gitDiffFiles, gitDiffCommits } from "@/lib/api";
import type { TimelineSnapshot, ArchitectureSnapshot, ArchitectureEvolution } from "@/lib/gitops/timelineApi";
import { CirclePackView } from "@/components/CirclePackView";

export function TimelineView({ repoId }: { repoId: string }) {
  const [snapshots, setSnapshots] = useState<TimelineSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentGraph, setCurrentGraph] = useState<ArchitectureSnapshot | null>(null);
  // The hash whose load has settled (resolved or failed). Deriving the snapshot
  // spinner from this rather than a boolean means it can't be left on by a
  // superseded response, and keeps the flag out of the effect's render pass.
  const [loadedHash, setLoadedHash] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  
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

  const pause = useCallback(() => {
    setPlaying(false);
    clearInterval(playRef.current);
    playRef.current = undefined;
  }, []);

  // Both loads live inside their effect rather than in a hoisted helper: the
  // `active` flag has to be the one the cleanup clears, and `react-hooks`
  // treats a call to any setState-bearing `useCallback` as a synchronous
  // cascade even when every write is in a promise continuation.
  useEffect(() => {
    let active = true;
    timelineMetadata(repoId, "everyCommit")
      .then((data) => {
        if (!active) return;
        setSnapshots(data);
        if (data.length > 0) {
          setCurrentIndex(data.length - 1); // default to latest
        }
      })
      .catch((e) => logger.error("Failed to load timeline metadata", { err: e, repoId }))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; pause(); };
  }, [repoId, reloadToken, pause]);

  // Playback advances every 3s and the scrubber can jump faster than a
  // snapshot request returns, so a superseded response must not paint over
  // the frame the user is actually looking at.
  useEffect(() => {
    if (snapshots.length === 0) return;
    let active = true;
    const { hash } = snapshots[currentIndex];
    timelineSnapshot(repoId, hash)
      .then((snap) => { if (active) setCurrentGraph(snap); })
      .catch((e) => logger.error("Failed to load timeline snapshot", { err: e, repoId, hash }))
      .finally(() => { if (active) setLoadedHash(hash); });
    return () => { active = false; };
  }, [repoId, currentIndex, snapshots]);

  async function handleBuild() {
    setBuilding(true);
    try {
      await timelineBuild(repoId, "everyCommit");
      // Hold the full-page loading state until the reload lands, so the
      // "not built" empty state doesn't flash between the two.
      setLoading(true);
      setReloadToken((n) => n + 1);
    } catch (e) {
      logger.error("Failed to build timeline", { err: e, repoId });
    } finally {
      setBuilding(false);
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

  if (loading) {
    return <div className="flex items-center gap-sm text-gray-400 py-xl justify-center"><Loader2 className="w-5 h-5 animate-spin"/> Loading timeline...</div>;
  }

  if (snapshots.length === 0) {
    return (
      <div className="border border-dashed border-white/10 rounded-xl p-xl text-center flex flex-col items-center">
        <h3 className="text-white font-medium mb-sm">Timeline not built</h3>
        <p className="text-meta text-gray-400 mb-lg max-w-note">The historical architecture timeline needs to be extracted from Git and analyzed.</p>
        <button 
          onClick={handleBuild} 
          disabled={building}
          className="flex items-center gap-sm bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 px-md py-sm rounded-lg text-meta transition-colors disabled:opacity-50"
        >
          {building ? <Loader2 className="w-4 h-4 animate-spin"/> : null}
          {building ? "Building Timeline (This may take a while)..." : "Build Timeline"}
        </button>
      </div>
    );
  }

  const currentMeta = snapshots[currentIndex];
  const graphLoading = loadedHash !== currentMeta.hash;
  
  return (
    <>
      <div className="flex flex-col gap-lg">
      {/* Metrics Row */}
      <div className="grid grid-cols-6 gap-md">
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
      <div className="grid grid-cols-3 gap-lg">
        <div className="col-span-2 relative min-h-[500px] border border-white/5 bg-[#0a0a0a] rounded-xl overflow-hidden p-md">
          {graphLoading && (
            <div className="absolute top-4 right-4 z-10 flex items-center gap-sm text-meta bg-black/50 backdrop-blur px-sm py-xs rounded-full text-gray-400">
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
        <div className="col-span-1 border border-white/5 bg-[#0a0a0a] rounded-xl p-md flex flex-col gap-md overflow-y-auto max-h-[600px]">
          <h3 className="text-meta font-semibold text-white">Architecture Evolution</h3>
          
          {currentGraph?.evolution?.aiNarrative && (
            <div className="bg-purple-500/10 border border-purple-500/20 p-sm rounded-lg">
              <p className="text-meta text-purple-200 mb-sm">{currentGraph.evolution.aiNarrative.reason}</p>
              <p className="text-meta text-purple-300 font-medium">💡 {currentGraph.evolution.aiNarrative.recommendation}</p>
            </div>
          )}

          <div className="flex flex-col gap-sm">
            <h4 className="text-meta text-gray-500 uppercase tracking-wider">Events</h4>
            {currentGraph?.evolution?.events.map((e, i) => (
              <div key={i} className="bg-white/5 p-sm rounded-lg border border-white/5">
                <span className="text-micro bg-white/10 px-sm py-hair rounded text-gray-300 mb-sm inline-block">{e.category}</span>
                <div className="text-meta text-gray-200 font-medium">{e.title}</div>
                <div className="text-meta text-gray-400 mt-2xs">{e.description}</div>
              </div>
            ))}
            {!currentGraph?.evolution?.events.length && (
              <div className="text-meta text-gray-500 italic">No significant events in this snapshot.</div>
            )}
          </div>
          
          <div className="flex flex-col gap-sm mt-sm">
            <h4 className="text-meta text-gray-500 uppercase tracking-wider">Module Health</h4>
            {currentGraph?.evolution?.moduleHealth && Object.values(currentGraph.evolution.moduleHealth).slice(0, 5).map(m => (
              <div key={m.moduleId} className="flex items-center justify-between text-meta p-sm bg-white/5 rounded border border-white/5">
                <span className="text-gray-300 truncate max-w-[120px]" title={m.moduleId}>{m.moduleId}</span>
                <span className={`px-sm py-hair rounded ${m.healthScore > 80 ? 'text-green-400 bg-green-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                  {m.healthScore.toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Scrubber / Controls */}
      <div className="bg-[#111] border border-white/10 rounded-xl p-md flex flex-col gap-md">
        <div className="flex items-center gap-md">
          <button onClick={togglePlay} className="p-sm bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors">
            {playing ? <Pause className="w-4 h-4"/> : <Play className="w-4 h-4" fill="currentColor" />}
          </button>
          
          <select 
            value={currentIndex}
            onChange={(e) => {
              pause();
              setCurrentIndex(parseInt(e.target.value));
            }}
            /* `min-w-0`: a <select> sizes to its widest OPTION, and these options are
               full commit subjects. Without it the control measured 527px inside a
               390px viewport and dragged the whole page sideways. */
            className="min-w-0 flex-1 bg-black border border-white/10 text-white rounded-lg px-sm py-sm text-meta focus:outline-none focus:border-purple-500"
          >
            {snapshots.map((snap, i) => (
              <option key={snap.hash} value={i}>
                {new Date(snap.timestamp * 1000).toLocaleDateString()} — {snap.hash.substring(0,7)}: {snap.message.substring(0, 50)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-between text-meta text-gray-500 font-mono">
          <span>{new Date(snapshots[0].timestamp * 1000).toLocaleDateString()}</span>
          <span className="text-gray-300 font-medium truncate max-w-[50%] text-center px-md">
            {currentMeta.message}
          </span>
          <span>{new Date(snapshots[snapshots.length - 1].timestamp * 1000).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Main View Issues */}
      {currentGraph?.result?.issues && currentGraph.result.issues.length > 0 && (
        <div className="bg-[#111] border border-white/10 rounded-xl p-lg mt-sm">
          <h3 className="text-meta font-semibold text-white mb-md">Issues in this Snapshot ({currentGraph.result.issues.length})</h3>
          <div className="max-h-[300px] overflow-y-auto pr-sm">
            {currentGraph.result.issues.map((iss: any, i: number) => (
              <IssueItem key={i} issue={iss} />
            ))}
          </div>
        </div>
      )}

      {/* Ad-Hoc Compare Section */}
      <div className="bg-[#111] border border-white/10 rounded-xl p-lg mt-md">
        <h3 className="text-lede font-semibold text-white mb-md">Ad-Hoc Architecture Diff</h3>
        <p className="text-meta text-gray-400 mb-lg">Select any two commits to compare their architectural evolution.</p>
        
        <div className="flex items-end gap-md mb-lg">
          <div className="flex-1">
            <label className="block text-meta text-gray-500 mb-2xs">Base Snapshot</label>
            <select 
              value={compareBase}
              onChange={e => setCompareBase(e.target.value)}
              className="w-full bg-black border border-white/10 text-white rounded-lg px-sm py-sm text-meta focus:outline-none focus:border-purple-500"
            >
              <option value="">Select Base...</option>
              {snapshots.map(s => <option key={s.hash} value={s.hash}>{s.hash.substring(0,7)} — {s.message.substring(0, 50)}</option>)}
            </select>
          </div>
          
          <div className="flex-1">
            <label className="block text-meta text-gray-500 mb-2xs">Head Snapshot</label>
            <select 
              value={compareHead}
              onChange={e => setCompareHead(e.target.value)}
              className="w-full bg-black border border-white/10 text-white rounded-lg px-sm py-sm text-meta focus:outline-none focus:border-purple-500"
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
                logger.error("Failed to compare timeline snapshots", { err, repoId, base: compareBase, head: compareHead });
              } finally {
                setComparing(false);
              }
            }}
            disabled={comparing || !compareBase || !compareHead}
            className="bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white px-lg py-sm rounded-lg text-meta font-medium transition-colors"
          >
            {comparing ? <Loader2 className="w-4 h-4 animate-spin"/> : "Compare"}
          </button>
        </div>
        
        {comparisonEvolution && (
          <div className="flex flex-col gap-lg mt-lg">
            <div className="grid grid-cols-3 gap-lg bg-[#0a0a0a] border border-white/5 rounded-xl p-md">
              <div className="flex flex-col gap-sm max-h-[400px] overflow-y-auto pr-sm">
                <h4 className="text-meta text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-sm z-10">
                  Evolution Events ({compareBase.substring(0,7)} → {compareHead.substring(0,7)})
                </h4>
                {comparisonEvolution.events.map((e, i) => (
                  <div key={i} className="bg-white/5 p-sm rounded-lg border border-white/5">
                    <span className="text-micro bg-white/10 px-sm py-hair rounded text-gray-300 mb-sm inline-block">{e.category}</span>
                    <div className="text-meta text-gray-200 font-medium">{e.title}</div>
                    <div className="text-meta text-gray-400 mt-2xs">{e.description}</div>
                  </div>
                ))}
              </div>
              
              {/* Changed Files Column */}
              <div className="flex flex-col gap-sm max-h-[400px] overflow-y-auto pr-sm">
                <h4 className="text-meta text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-sm z-10">
                  Changed Files ({changedFiles.length})
                </h4>
                {changedFiles.length === 0 ? (
                  <div className="text-meta text-gray-500 italic">No files changed.</div>
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
                        className="flex items-center gap-sm bg-white/5 hover:bg-white/10 p-sm rounded-lg border border-transparent hover:border-white/10 text-left transition-colors w-full"
                      >
                        <span className={`text-micro font-mono shrink-0 px-xs py-hair rounded ${file.status === 'A' ? 'bg-green-500/20 text-green-400' : file.status === 'D' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {file.status}
                        </span>
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-meta font-medium text-gray-200 truncate">{fileName}</span>
                          <span className="text-micro text-gray-500 truncate font-mono mt-hair">{file.path}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
              
              <div className="flex flex-col gap-md">
                <div>
                  <h4 className="text-meta text-gray-500 uppercase tracking-wider mb-sm">Metrics Shift</h4>
                  <div className="grid grid-cols-2 gap-sm">
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
                  <div className="bg-purple-500/10 border border-purple-500/20 p-sm rounded-lg">
                    <h4 className="text-meta text-purple-400 uppercase tracking-wider mb-sm">AI Summary</h4>
                    <p className="text-meta text-purple-200 mb-sm">{comparisonEvolution.aiNarrative.reason}</p>
                    <p className="text-meta text-purple-300 font-medium">💡 {comparisonEvolution.aiNarrative.recommendation}</p>
                  </div>
                )}
              </div>
            </div>
            
            {/* Issues Shift */}
            {(comparisonEvolution.issueDiff?.introduced?.length > 0 || comparisonEvolution.issueDiff?.resolved?.length > 0) && (
              <div className="grid grid-cols-2 gap-lg bg-[#0a0a0a] border border-white/5 rounded-xl p-md">
                <div className="flex flex-col gap-sm max-h-[300px] overflow-y-auto pr-sm">
                  <h4 className="text-meta text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-sm z-10">
                    Issues Introduced ({comparisonEvolution.issueDiff.introduced.length})
                  </h4>
                  {comparisonEvolution.issueDiff.introduced.length === 0 ? (
                    <div className="text-meta text-gray-500 italic">No new issues introduced.</div>
                  ) : (
                    comparisonEvolution.issueDiff.introduced.map((iss: any, i: number) => (
                      <IssueItem key={i} issue={iss} />
                    ))
                  )}
                </div>
                <div className="flex flex-col gap-sm max-h-[300px] overflow-y-auto pr-sm">
                  <h4 className="text-meta text-gray-500 uppercase tracking-wider sticky top-0 bg-[#0a0a0a] py-sm z-10">
                    Issues Resolved ({comparisonEvolution.issueDiff.resolved.length})
                  </h4>
                  {comparisonEvolution.issueDiff.resolved.length === 0 ? (
                    <div className="text-meta text-gray-500 italic">No issues resolved.</div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-lg">
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl w-full max-w-frame max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between p-md border-b border-white/5 bg-[#111]">
              <div className="flex items-center gap-sm">
                <FileText className="w-4 h-4 text-purple-400" />
                <h3 className="text-meta font-mono text-gray-200">{selectedFile}</h3>
              </div>
              <button 
                onClick={() => { setSelectedFile(null); setFileDiffText(null); }}
                className="p-2xs hover:bg-white/10 rounded text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-md">
              {loadingDiff ? (
                <div className="flex items-center justify-center h-full text-gray-500 gap-sm">
                  <Loader2 className="w-4 h-4 animate-spin"/> Loading diff...
                </div>
              ) : (
                <div className="text-meta font-mono text-gray-300 whitespace-pre-wrap flex flex-col w-full bg-[#050505] p-sm rounded-lg border border-white/5">
                  {!fileDiffText ? (
                    <span className="text-gray-500 italic">No changes visible.</span>
                  ) : (
                    fileDiffText.split("\n").map((line, i) => {
                      let lineClass = "px-md py-hair w-full ";
                      if (line.startsWith("+") && !line.startsWith("+++")) {
                        lineClass += "bg-green-500/10 text-green-400";
                      } else if (line.startsWith("-") && !line.startsWith("---")) {
                        lineClass += "bg-red-500/10 text-red-400";
                      } else if (line.startsWith("@@")) {
                        lineClass += "bg-cyan-500/10 text-cyan-400 mt-sm mb-2xs rounded";
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
    <div className="bg-white/5 border border-white/10 p-md rounded-xl flex flex-col">
      <div className="flex items-center gap-xs mb-2xs">
        <span className="text-meta text-gray-400">{label}</span>
        {info && (
          <div className="group relative flex items-center">
            <Info className="w-3 h-3 text-gray-500 hover:text-gray-300 cursor-help" />
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-sm w-48 opacity-0 transition-opacity group-hover:opacity-100 z-50 bg-gray-900 border border-white/10 text-gray-300 text-meta rounded p-sm shadow-xl">
              {info}
            </div>
          </div>
        )}
      </div>
      <span className="text-lede font-medium text-white">{value}</span>
      {sub && <span className="text-meta text-gray-500 mt-2xs truncate">{sub}</span>}
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
    <div className="py-sm flex items-start gap-sm border-b border-white/5 last:border-0">
      <span className={`text-micro font-mono px-xs py-hair rounded border shrink-0 mt-hair ${SEV_COLOR[issue.severity] || SEV_COLOR[1]}`}>
        S{issue.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-meta text-gray-200">{issue.title}</div>
        <div className="text-meta text-gray-500 font-mono truncate">{issue.file}:{issue.line}</div>
      </div>
    </div>
  );
}
