import type { ArchitectureSnapshot } from "./historicalAnalysis";
import { generateNarrative } from "../agents/narrativeAgent";
import { diffSnapshots, type GraphDiff } from "./graphDiff";
import type { CodeSymbol, GraphNode, ModuleNode } from "../types";

export type EvolutionCategory =
  | "FEATURE_INTRODUCED"
  | "FEATURE_REMOVED"
  | "FEATURE_SPLIT"
  | "MODULE_EXTRACTED"
  | "LAYER_CREATED"
  | "LAYER_REMOVED"
  | "DEPENDENCY_ADDED"
  | "DEPENDENCY_REMOVED"
  | "API_CHANGED"
  | "DATABASE_CHANGED"
  | "PLUGIN_ADDED"
  | "PLUGIN_REMOVED"
  | "REFACTOR"
  | "ARCHITECTURE_PATTERN_CHANGED"
  | "TESTING_IMPROVED"
  | "SECURITY_IMPROVED"
  | "PERFORMANCE_IMPROVED";

export interface EvolutionEvent {
  category: EvolutionCategory;
  title: string;
  description: string;
  impact: string[];
  affectedNodes: string[]; // Node IDs
}

export interface ModuleHealth {
  moduleId: string;
  created: number; // Timestamp
  lastModified: number; // Timestamp
  growthLoc: number; // Delta in LOC
  dependencies: number;
  complexity: number;
  stability: number; // 0-100 (100 = never changes, 0 = churns every commit)
  mostChangedFiles: string[];
  owner: string; // Based on Git author dominance
  healthScore: number; // 0-100
}

export interface ArchitectureMetrics {
  coupling: number; // Ratio of inter-module edges
  cohesion: number; // Ratio of intra-module edges
  dependencyDensity: number;
  circularDependencies: number;
  averageModuleSize: number;
  largestModule: string;
  hotspots: string[];
  averageFanIn: number;
  averageFanOut: number;
  layerViolations: number;
  architectureScore: number; // 0-100 deterministic score
}

export interface FeatureEvolution {
  featureId: string;
  name: string;
  history: Array<{
    hash: string;
    timestamp: number;
    status: string; // e.g. "Introduced", "Expanded", "Refactored"
  }>;
  currentStatus: string;
}

export interface ArchitectureEvolution {
  metrics: ArchitectureMetrics;
  baselineMetrics?: ArchitectureMetrics;
  events: EvolutionEvent[];
  moduleHealth: Record<string, ModuleHealth>;
  featureEvolution: Record<string, FeatureEvolution>;
  aiNarrative?: {
    reason: string;
    recommendation: string;
  };
}

/**
 * The Architecture Evolution Engine.
 * Deterministically analyzes state changes between two snapshots to produce
 * a rich, categorised evolution model.
 */
export async function analyzeEvolution(
  older: ArchitectureSnapshot | null,
  newer: ArchitectureSnapshot
): Promise<ArchitectureEvolution> {
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

  // 5. Generate Narrative (Only for significant milestones)
  let aiNarrative: { reason: string; recommendation: string } | undefined;
  
  // Heuristic for "significant milestone": multiple major events or >15% coupling shift
  const significantEvents = events.filter(e => e.category !== "FEATURE_INTRODUCED").length > 0;
  if (older && significantEvents) {
    const oldMetrics = computeArchitectureMetrics(older);
    aiNarrative = await generateNarrative(oldMetrics, metrics, events);
  }

  // 4. Compute Module Health
  const moduleHealth = computeModuleHealth(older, newer, diff);

  return {
    metrics,
    baselineMetrics,
    events,
    moduleHealth,
    featureEvolution: {}, // To be populated across timelines
    aiNarrative
  };
}

function computeArchitectureMetrics(snap: ArchitectureSnapshot): ArchitectureMetrics {
  const nodes = snap.result.viz.nodes;
  const edges = snap.result.viz.edges;
  
  let totalFanIn = 0;
  let totalFanOut = 0;
  
  nodes.forEach(n => {
    totalFanIn += n.fanIn;
    // Fan-out approximation from edges where this node is source
    totalFanOut += edges.filter(e => e.source === n.id).length;
  });

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
    circularDependencies: 0, // Requires deeper Tarjan's SCC analysis on edges
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
