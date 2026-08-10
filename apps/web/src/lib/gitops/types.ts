import type { TimelineSnapshot } from "./timeline";
import type { IndexResult, Issue } from "../types";

/**
 * The shared type vocabulary of the gitops snapshot/evolution pipeline.
 *
 * These types live here rather than beside the functions that produce them because
 * the producers form a legitimate runtime call chain — `historicalAnalysis` calls
 * `analyzeEvolution`, which calls `diffSnapshots` — while every
 * one of those modules also needs to *name* the types the others produce. Declaring the
 * types in the producer modules turned that one-way call chain into three import cycles
 * (dependency-cruiser `no-circular`). Types have no runtime edge, so hoisting them to a
 * leaf module breaks the cycles without moving a single line of logic.
 */

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

export interface IssueDiff {
  introduced: Issue[];
  resolved: Issue[];
}

export interface ArchitectureEvolution {
  metrics: ArchitectureMetrics;
  baselineMetrics?: ArchitectureMetrics;
  events: EvolutionEvent[];
  issueDiff: IssueDiff;
  moduleHealth: Record<string, ModuleHealth>;
  featureEvolution: Record<string, FeatureEvolution>;
}
