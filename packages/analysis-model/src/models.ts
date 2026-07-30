import type { SymbolGraph } from "@codegraph/core-graph";

/**
 * The v1 analysis output models.
 *
 * Moved verbatim from `apps/web/src/lib/types.ts` (LLD §13.2). These are the
 * shapes `indexRepo` and `scoreIssues` PRODUCE, which is why they travel with the
 * pipeline rather than staying behind as app view types. The app's own view and
 * API models (`RepoDetail`, `RepoSummary`, `Fleet*`, `TrashEntry`, `Assistant*`,
 * `Job`) stayed in `apps/web`, because nothing here produces them.
 *
 * NOT `core-domain`'s model, and deliberately not merged with it. `core-domain`
 * declares the v2 taxonomy, and the two have diverged:
 *
 *   core-domain `Dimension`: 6 members, includes "performance"
 *   this `Dimension`       : 5 members, no "performance"
 *
 * `scoreIssues` computes the overall score as `Σ score × weight` over
 * `DIMENSION_META`, whose five weights sum to exactly 1.0. Adopting the
 * six-member type forces a sixth weight taken from the other five, which moves
 * every repository's Health Score — a behaviour change P2 may not make.
 * `"performance"` is not missing by oversight either: it is an *agent*, and the
 * swarm's `Finding` carries `agent` with no `dimension` field at all. Whether it
 * earns score weight, and from where, is a real P3 design question.
 */

export type Dimension =
  | "correctness"
  | "security"
  | "maintainability"
  | "dependency_hygiene"
  | "test_integrity";

export interface DimensionScore {
  dimension: Dimension;
  score: number; // 0..100
  penalty: number; // raw accumulated penalty
  issueCount: number;
}

export interface Issue {
  id: string;
  dimension: Dimension;
  severity: number; // 1..5
  confidence?: number; // 0..1
  title: string;
  file: string;
  line: number;
  blastRadius: number; // >=1, graph fan-in weighting
  churn?: number; // commit count over last 6mo, for hotspot prioritization
  /**
   * Total matches for this rule in this file, when it exceeds the per-rule
   * emit cap.
   *
   * Set on the FIRST emitted issue of a (rule, file) group only — the others
   * are location markers for the UI, and multiplying the volume factor once per
   * emitted issue would count the same excess five times. `undefined` means
   * "at or under the cap", which is the common case and scores exactly as it
   * did before this field existed (review item B3).
   */
  occurrences?: number;
}

export interface LanguageStat {
  language: string;
  files: number;
  loc: number;
}

export interface GraphStats {
  nodes: number; // files + dirs + deps
  edges: number; // imports + containment
  files: number;
  dirs: number;
  dependencies: number;
}

// --- Visualization graph (the actual node/edge network to render) ---
export type GraphNodeKind = "dir" | "file" | "dependency";

export interface GraphNode {
  id: string; // path (files/dirs) or "dep:name"
  label: string; // short display name
  kind: GraphNodeKind;
  language: string | null;
  loc: number;
  fanIn: number; // how many files import this (centrality)
  issues: number; // issue count attributed to this node
  worstSeverity: number; // 0..5
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "imports" | "contains" | "depends";
}

export interface VizGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean; // true if capped for rendering
}

// --- File tree for circle-packing visualization ---
export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[]; // present on directories
  ext?: string; // present on files, e.g. ".ts"
  loc?: number; // present on files
  issues?: number; // present on files
}

// --- Module-level architecture graph (flowchart) ---
export interface ModuleNode {
  id: string; // top-level dir name, or "(root)"
  label: string;
  files: number;
  loc: number;
  issues: number;
  language: string | null; // dominant language
  tier: number; // dependency layer for layout
}

export interface ModuleEdge {
  source: string;
  target: string;
  weight: number; // number of imports between modules
}

export interface ModuleGraph {
  nodes: ModuleNode[];
  edges: ModuleEdge[];
}

export interface IndexResult {
  score: number;
  loc: number;
  languages: LanguageStat[];
  graphStats: GraphStats;
  dimensions: DimensionScore[];
  issues: Issue[];
  dependencies: string[]; // actual package names this repo depends on
  churnByFile: Record<string, number>;
  tree: TreeNode;
  viz: VizGraph;
  modules: ModuleGraph;
  symbolGraph: SymbolGraph;
}

export const DIMENSION_META: Record<
  Dimension,
  { label: string; weight: number; color: string }
> = {
  correctness: { label: "Correctness", weight: 0.26, color: "#34d399" },
  security: { label: "Security", weight: 0.24, color: "#fb7185" },
  maintainability: { label: "Maintainability", weight: 0.22, color: "#a78bfa" },
  dependency_hygiene: { label: "Dependency hygiene", weight: 0.16, color: "#fbbf24" },
  test_integrity: { label: "Test integrity", weight: 0.12, color: "#22d3ee" },
};
