import { diffSnapshots, type GraphDiff } from "./graphDiff";
import type { CodeSymbol, GraphEdge, GraphNode, ModuleNode, Issue } from "../types";
import type {
  ArchitectureEvolution,
  ArchitectureMetrics,
  ArchitectureSnapshot,
  EvolutionCategory,
  EvolutionEvent,
  FeatureEvolution,
  IssueDiff,
  ModuleHealth,
} from "./types";

/**
 * The Architecture Evolution Engine.
 * Deterministically analyzes state changes between two snapshots to produce
 * a rich, categorised evolution model.
 *
 * Synchronous, and that is the point: every number and every event below is
 * computed from the two snapshots in front of it. This used to be `async`
 * solely to await a language model that wrote a prose "why did this change"
 * paragraph over the top of the metrics — an unverifiable claim attached to
 * verifiable numbers. It is gone, and with it the only reason this function
 * ever suspended.
 */
export function analyzeEvolution(
  older: ArchitectureSnapshot | null,
  newer: ArchitectureSnapshot
): ArchitectureEvolution {
  // 1. Compute raw structural diff if an older snapshot exists
  const diff = older ? diffSnapshots(older, newer) : null;
  
  // 2. Deterministically compute current architecture metrics
  const metrics = computeArchitectureMetrics(newer);
  const baselineMetrics = older ? computeArchitectureMetrics(older) : undefined;
  
  // 3. Categorize changes into Evolution Events
  const events = diff ? categorizeEvents(diff) : [
    {
      category: "FEATURE_INTRODUCED" as EvolutionCategory,
      title: "Initial Architecture Analyzed",
      description: "First architectural snapshot recorded.",
      impact: ["Baseline established"],
      affectedNodes: []
    }
  ];

  // 4. Compute Module Health & Issue Diff
  const issueDiff = computeIssueDiff(older, newer);
  const moduleHealth = computeModuleHealth(older, newer, diff);

  return {
    metrics,
    issueDiff,
    baselineMetrics,
    events,
    moduleHealth,
    featureEvolution: {}, // To be populated across timelines
  };
}

function computeIssueDiff(older: ArchitectureSnapshot | null, newer: ArchitectureSnapshot): IssueDiff {
  if (!older) return { introduced: newer.result.issues, resolved: [] };

  const issueKey = (i: Issue) => `${i.file}::${i.title}`;
  const oldKeys = new Set(older.result.issues.map(issueKey));
  const newKeys = new Set(newer.result.issues.map(issueKey));

  return {
    introduced: newer.result.issues.filter(i => !oldKeys.has(issueKey(i))),
    resolved: older.result.issues.filter(i => !newKeys.has(issueKey(i)))
  };
}

/**
 * Circular dependencies in the FILE import graph, as a count of strongly connected components
 * larger than one node.
 *
 * This field used to be the literal `0` with a comment saying it "requires deeper Tarjan's SCC
 * analysis on edges". It does not: the snapshot already carries the import edges, and an
 * import cycle is an SCC over them. Zero is not a neutral placeholder for a metric named
 * `circularDependencies` — it is the answer a clean repository gets, so the placeholder was
 * indistinguishable from a real measurement of "none", including across a Timeline comparison
 * where the number is supposed to show a trend.
 *
 * File-level, not symbol-level, deliberately: `viz.edges` are imports between files, and
 * `QueryEngine.cycles()` already answers the symbol-level question over the call graph. These
 * are different questions with different answers, and this snapshot only has the import one.
 *
 * Iterative Tarjan — the recursive form blows the stack on a deep import chain, and this runs
 * against arbitrary repositories.
 */
function importCycleCount(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): number {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "imports") continue;
    const list = out.get(e.source);
    if (list) list.push(e.target);
    else out.set(e.source, [e.target]);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  let cycles = 0;

  for (const root of nodes) {
    if (index.has(root.id)) continue;
    index.set(root.id, idx);
    low.set(root.id, idx);
    idx++;
    stack.push(root.id);
    onStack.add(root.id);
    const frames: [string, number][] = [[root.id, 0]];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const [v] = frame;
      const targets = out.get(v) ?? [];
      let descended = false;

      for (let j = frame[1]; j < targets.length; j++) {
        const w = targets[j]!;
        if (!index.has(w)) {
          frame[1] = j + 1;
          index.set(w, idx);
          low.set(w, idx);
          idx++;
          stack.push(w);
          onStack.add(w);
          frames.push([w, 0]);
          descended = true;
          break;
        }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        frame[1] = j + 1;
      }
      if (descended) continue;

      frames.pop();
      const parent = frames[frames.length - 1]?.[0];
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(v)!));

      if (low.get(v) === index.get(v)) {
        let size = 0;
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          size++;
        } while (w !== v);
        // A one-node component is a cycle only if the file imports itself, which the import
        // extractor does not emit; anything larger is a genuine import cycle.
        if (size > 1) cycles++;
      }
    }
  }

  return cycles;
}

function computeArchitectureMetrics(snap: ArchitectureSnapshot): ArchitectureMetrics {
  const nodes = snap.result.viz.nodes;
  const edges = snap.result.viz.edges;
  
  let totalFanIn = 0;

  // Fan-out per node in ONE pass over the edges. This was `nodes.forEach(n =>
  // edges.filter(e => e.source === n.id).length)` — a full edge scan per node, so O(N·E), on
  // a payload that reaches thousands of nodes and edges on a real repository, re-run for
  // every snapshot the Timeline builds.
  const fanOutById = new Map<string, number>();
  for (const e of edges) fanOutById.set(e.source, (fanOutById.get(e.source) ?? 0) + 1);
  let totalFanOut = 0;
  for (const n of nodes) {
    totalFanIn += n.fanIn;
    totalFanOut += fanOutById.get(n.id) ?? 0;
  }

  const nodeCount = nodes.length || 1;
  const edgeCount = edges.length;
  
  // Coupling: Ratio of inter-module dependencies to total dependencies
  const totalImports = edges.filter(e => e.kind === "imports").length || 1;
  const interModuleImports = snap.result.modules.edges.reduce((sum, e) => sum + e.weight, 0);
  const coupling = Math.min(1, interModuleImports / totalImports);
  
  // Determine largest module
  const modules = snap.result.modules.nodes;
  let largestModule = "None";
  let maxLoc = 0;
  let totalSize = 0;
  
  modules.forEach(m => {
    totalSize += m.loc;
    if (m.loc > maxLoc) {
      maxLoc = m.loc;
      largestModule = m.id;
    }
  });

  // Use the robust, pre-computed health score from the main indexer
  const architectureScore = snap.result.score;

  return {
    coupling,
    cohesion: 1 / (coupling + 1), // Inverse heuristic for baseline
    dependencyDensity: edgeCount / (nodeCount * nodeCount),
    circularDependencies: importCycleCount(nodes, edges),
    averageModuleSize: modules.length ? totalSize / modules.length : 0,
    largestModule,
    hotspots: nodes.filter(n => n.issues > 3).map(n => n.id).slice(0, 5),
    averageFanIn: totalFanIn / nodeCount,
    averageFanOut: totalFanOut / nodeCount,
    layerViolations: 0, // Requires defined layer rules
    architectureScore
  };
}

function categorizeEvents(diff: GraphDiff): EvolutionEvent[] {
  const events: EvolutionEvent[] = [];
  
  // Look for major API additions
  const apiAdded = diff.symbols.added.filter(s => s.kind === "interface" || (s.name.toLowerCase().includes("api")));
  if (apiAdded.length > 0) {
    events.push({
      category: "API_CHANGED",
      title: "API Surface Expanded",
      description: `Added ${apiAdded.length} new API contracts.`,
      impact: ["Increased integration capabilities", "Complexity increased"],
      affectedNodes: apiAdded.map(a => a.id)
    });
  }

  // Look for extracted modules (many nodes moved/added in a specific dir)
  const dirAdditions = new Set(diff.files.added.map(f => f.id.split('/')[0]));
  dirAdditions.forEach(dir => {
    events.push({
      category: "MODULE_EXTRACTED",
      title: `Module Extracted: ${dir}`,
      description: `A new directory structure was introduced for ${dir}.`,
      impact: ["Separation of concerns improved"],
      affectedNodes: [dir]
    });
  });
  
  // Look for refactors (high modified/removed ratio)
  if (diff.files.removed.length > 5 && diff.files.added.length > 0) {
    events.push({
      category: "REFACTOR",
      title: "Major Structural Refactor",
      description: `Removed ${diff.files.removed.length} components, added ${diff.files.added.length}.`,
      impact: ["Code pruning", "Potential regression risk"],
      affectedNodes: []
    });
  }

  // Look for dependency additions
  if (diff.fileEdges.added.length > 10) {
    events.push({
      category: "DEPENDENCY_ADDED",
      title: "Dependency Graph Expanded",
      description: `Introduced ${diff.fileEdges.added.length} new imports between files.`,
      impact: ["Coupling increased"],
      affectedNodes: []
    });
  }

  return events;
}

function computeModuleHealth(
  older: ArchitectureSnapshot | null, 
  newer: ArchitectureSnapshot,
  diff: GraphDiff | null
): Record<string, ModuleHealth> {
  const health: Record<string, ModuleHealth> = {};
  
  newer.result.modules.nodes.forEach(m => {
    let growth = 0;
    let stability = 100;
    
    // Find matching older module to compute growth
    if (older) {
      const oldM = older.result.modules.nodes.find(old => old.id === m.id);
      if (oldM) {
        growth = m.loc - oldM.loc;
        // Basic stability heuristic: if issues grew, stability drops
        stability -= Math.max(0, (m.issues - oldM.issues) * 10);
      } else {
        growth = m.loc; // entirely new
      }
    }
    
    health[m.id] = {
      moduleId: m.id,
      created: newer.timeline.timestamp, // In real scenario, track historically
      lastModified: newer.timeline.timestamp,
      growthLoc: growth,
      dependencies: 0, // Calculate from edges
      complexity: m.issues, // Proxy for complexity
      stability: Math.max(0, Math.min(100, stability)),
      mostChangedFiles: [], // Extract from churn metric
      owner: newer.timeline.author, // Primary committer
      healthScore: Math.max(0, 100 - m.issues * 5)
    };
  });
  
  return health;
}
