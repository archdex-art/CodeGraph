// Shared types between backend (API routes) and frontend.

// A re-export alone would not bring these into local scope, and `IndexResult` /
// `RepoDetail` below both reference `SymbolGraph`.
import type { ContextSlice, SymbolGraph } from "@codegraph/core-graph";

// --- Analysis output models ---
// Moved to `@codegraph/analysis-model` (LLD §13.2): these are the shapes `indexRepo`
// PRODUCES, so they travel with the pipeline. Re-exported here so every existing
// importer of this module keeps working; deleted in §13.1 step 3.
//
// Imported as values/types locally too, because `RepoDetail` and `RepoSummary`
// below reference them and a bare re-export does not bring names into scope.
import type {
  Dimension,
  DimensionScore,
  GraphStats,
  Issue,
  LanguageStat,
  ModuleGraph,
  TreeNode,
  VizGraph,
} from "@codegraph/analysis-model";

export type {
  Dimension,
  DimensionScore,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  GraphStats,
  IndexResult,
  Issue,
  LanguageStat,
  ModuleEdge,
  ModuleGraph,
  ModuleNode,
  TreeNode,
  VizGraph,
} from "@codegraph/analysis-model";
export { DIMENSION_META, PILLAR_META, pillarsFrom } from "@codegraph/analysis-model";
export type { Pillar, PillarScore } from "@codegraph/analysis-model";

export type JobStatus = "queued" | "cloning" | "indexing" | "scoring" | "done" | "error";



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
