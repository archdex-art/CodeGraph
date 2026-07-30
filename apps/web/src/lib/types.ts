// Shared types between backend (API routes) and frontend.

// A re-export alone would not bring these into local scope, and `IndexResult` /
// `RepoDetail` below both reference `SymbolGraph`.
import type { ContextSlice, SymbolGraph } from "@codegraph/core-graph";

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
/** A fleet node plus the dependency names its outgoing edges are derived from. */
export interface FleetRepo extends FleetNode {
  dependencies: string[];
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
  hasWorkspace: boolean;
  error: string | null;
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

// --- Code intelligence: symbol-level knowledge graph ---
// Moved to `@codegraph/core-graph` (LLD §13.2 — §3's charter names exactly these
// types, and the graph/query/extractor modules that consume them moved with
// them). Re-exported here so all 36 importers of this module keep working;
// deleted in §13.1 step 3 once none remain.
export type {
  CodeSymbol,
  ContextSlice,
  SymbolEdge,
  SymbolEdgeKind,
  SymbolGraph,
  SymbolKind,
} from "@codegraph/core-graph";

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

// --- Built-in editor: file tree entries (lazy, one level at a time) ---
// Defined in core-domain so `fsx` (which produces it) and the editor UI (which
// renders it) can share one declaration without the UI importing a module that
// touches node:fs. Re-exported here so existing importers are unaffected; the
// import is type-only and therefore erased, adding no runtime dependency to the
// client bundle.
export type { FsEntry } from "@codegraph/core-domain";

// --- Built-in editor: soft-deleted entries (restorable) ---
export interface TrashEntry {
  id: string;
  path: string; // workspace-relative path it was deleted from, posix separators
  name: string;
  type: "file" | "dir";
  size: number; // bytes (recursive for dirs)
  deletedAt: number; // epoch ms
}

// --- Built-in editor: Git status/branches/log ---
// Defined in core-domain so `vcs` (which produces them) and the Git panel
// (which renders them) share one declaration without the UI importing a module
// that shells out to git. Re-exported here so existing importers are
// unaffected; type-only, so nothing reaches the client bundle at runtime.
export type {
  GitBranch,
  GitFileStatus,
  GitLogEntry,
  GitStatus,
  GitStatusEntry,
} from "@codegraph/core-domain";

export type SaveMode = "local" | "git-manual" | "git-auto";

// --- Built-in editor: AI Assistant — two opt-in backends: Claude (Claude
// Agent SDK, needs ANTHROPIC_API_KEY) and any OpenAI-compatible local model
// server (Ollama/LM Studio/llama.cpp/vLLM, needs CG_LOCAL_LLM_BASE_URL +
// CG_LOCAL_LLM_MODEL). Either, both, or neither may be configured.
// Events streamed server -> client (SSE) for one assistant turn. `tool_call`/
// `tool_result` come from our own workspace-tool wrappers (see
// src/lib/agents/assistant.ts), not raw SDK internals, so the shape here is
// intentionally small and stable regardless of upstream SDK churn.
export type AssistantEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: Record<string, unknown> }
  | { kind: "tool_result"; tool: string; ok: boolean; summary: string }
  | { kind: "done"; costUsd: number; turns: number }
  | { kind: "error"; message: string };

export type AssistantProvider = "claude" | "local";

export interface AssistantProviders {
  claude: boolean;
  local: boolean;
  claudeModel?: string | null;
  localModel?: string | null;
  localBaseUrl?: string | null;
}
