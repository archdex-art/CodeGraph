// Shared types between backend (API routes) and frontend.

export type JobStatus = "queued" | "cloning" | "indexing" | "scoring" | "done" | "error";

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
  title: string;
  file: string;
  line: number;
  blastRadius: number; // >=1, graph fan-in weighting
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


// --- Enterprise Fleet Graph (Cross-Repo) ---
export interface FleetNode {
  id: string; // repo id
  name: string;
  url: string;
  score: number | null;
  sourceType: SourceType;
  loc: number;
}
export interface FleetEdge {
  source: string; // repo id
  target: string; // repo id
}
export interface FleetGraph {
  nodes: FleetNode[];
  edges: FleetEdge[];
}
export type SourceType = "git" | "local";

export interface RepoSummary {
  id: string;
  url: string;
  name: string;
  status: JobStatus;
  sourceType: SourceType;
  score: number | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface RepoDetail extends RepoSummary {
  error: string | null;
  loc: number;
  languages: LanguageStat[];
  graph: GraphStats;
  dimensions: DimensionScore[];
  issues: Issue[];
  dependencies: string[]; // actual package names this repo depends on
  viz: VizGraph;
  tree: TreeNode;
  modules: ModuleGraph;
  symbolGraph: SymbolGraph;
}

// --- Code intelligence: symbol-level knowledge graph ---
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "constant"
  | "component";

export interface CodeSymbol {
  id: string; // stable: `${file}#${name}@${line}`
  name: string;
  kind: SymbolKind;
  file: string;
  line: number; // 1-indexed start
  endLine: number;
  signature: string;
  doc: string | null; // leading doc comment, trimmed
  exported: boolean;
  language: string;
  loc: number;
  container: string | null; // enclosing symbol id (method -> class)
  fanIn: number; // resolved incoming references (callers)
  fanOut: number; // resolved outgoing references (callees)
  issues: number;
  tags: string[]; // semantic tags (auth, db, http, test, …)
}

export type SymbolEdgeKind = "calls" | "references" | "contains" | "imports" | "extends" | "implements";

export interface SymbolEdge {
  source: string; // symbol id
  target: string; // symbol id
  kind: SymbolEdgeKind;
}

export interface SymbolGraph {
  symbols: CodeSymbol[];
  edges: SymbolEdge[];
  truncated: boolean;
  stats: { symbols: number; edges: number; resolvedCalls: number };
}

// AI context (Graph-RAG) output.
export interface ContextSlice {
  symbol: CodeSymbol;
  reason: string; // why included: "seed" | "caller" | "callee" | "sibling" | "import"
  score: number;
}
export interface AIContext {
  query: string;
  seeds: string[]; // seed symbol ids
  slices: ContextSlice[];
  prompt: string; // assembled, token-budgeted prompt
  tokenEstimate: number;
  truncated: boolean;
}

export interface Job {
  id: string;
  repoId: string;
  status: JobStatus;
  progress: number; // 0..100
  message: string;
  error: string | null;
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
