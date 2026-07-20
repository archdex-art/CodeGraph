import { indexRepo } from "../indexer";
import type { TimelineSnapshot } from "./timeline";
import type { LoadedSnapshot } from "./snapshotLoader";
import type { IndexResult, CodeSymbol } from "../types";
import { analyzeEvolution, type ArchitectureEvolution } from "./evolutionEngine";

export interface SnapshotMetrics {
  loc: number;
  fileCount: number;
  dirCount: number;
  classes: number;
  functions: number;
  interfaces: number;
  averageComplexity: number;
  maxComplexity: number;
  averageFanIn: number;
  averageFanOut: number;
  orphanModules: number;
  dependencies: number;
}
export interface ArchitectureSnapshot {
  timeline: TimelineSnapshot;
  result: IndexResult;
  metrics: SnapshotMetrics;
  evolution?: ArchitectureEvolution;
}

export async function analyzeSnapshot(
  timelineEntry: TimelineSnapshot,
  loadedSnapshot: LoadedSnapshot,
  previousSnapshot?: ArchitectureSnapshot | null
): Promise<ArchitectureSnapshot> {
  // Run the existing AST pipeline on the extracted temporary directory
  const result = await indexRepo(loadedSnapshot.dir);
  
  // Phase 5: Compute Snapshot Metrics
  const metrics = computeMetrics(result);
  
  const baseSnapshot: ArchitectureSnapshot = {
    timeline: timelineEntry,
    result,
    metrics
  };

  baseSnapshot.evolution = await analyzeEvolution(previousSnapshot || null, baseSnapshot);
  
  return baseSnapshot;
}

function computeMetrics(result: IndexResult): SnapshotMetrics {
  const symbols = result.symbolGraph.symbols;
  
  let classes = 0;
  let functions = 0;
  let interfaces = 0;
  let totalComplexity = 0;
  let maxComplexity = 0;
  let totalFanIn = 0;
  let totalFanOut = 0;
  
  for (const sym of symbols) {
    if (sym.kind === "class") classes++;
    if (sym.kind === "function" || sym.kind === "method") functions++;
    if (sym.kind === "interface") interfaces++;
    
    if (sym.complexity !== undefined) {
      totalComplexity += sym.complexity;
      if (sym.complexity > maxComplexity) {
        maxComplexity = sym.complexity;
      }
    }
    
    totalFanIn += sym.fanIn;
    totalFanOut += sym.fanOut;
  }
  
  const orphanModules = result.viz.nodes.filter(n => n.kind === "file" && n.fanIn === 0).length;
  
  return {
    loc: result.loc,
    fileCount: result.graphStats.files,
    dirCount: result.graphStats.dirs,
    dependencies: result.graphStats.dependencies,
    classes,
    functions,
    interfaces,
    averageComplexity: symbols.length > 0 ? totalComplexity / symbols.length : 0,
    maxComplexity,
    averageFanIn: symbols.length > 0 ? totalFanIn / symbols.length : 0,
    averageFanOut: symbols.length > 0 ? totalFanOut / symbols.length : 0,
    orphanModules
  };
}
