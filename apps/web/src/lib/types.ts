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
  AdvisoryReport,
  ApiSurface,
  Dimension,
  DimensionScore,
  GraphStats,
  IndexPhase,
  Issue,
  LanguageStat,
  ModuleGraph,
  OwnershipReport,
  ScanCoverage,
  TaintReport,
  TreeNode,
  UnusedDependency,
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
export type { IndexPhase, Pillar, PillarScore, ScanCoverage } from "@codegraph/analysis-model";
export type {
  Advisory,
  AdvisoryReport,
  ApiEndpoint,
  ApiMethod,
  ApiSinkKind,
  ApiSurface,
  AuthorStat,
  DataFlowPath,
  FileOwner,
  OwnershipEntry,
  OwnershipReport,
  PackageImportSite,
  ReplacementImpact,
  SymbolOwnership,
  TaintPath,
  TaintReport,
  UnusedDependency,
} from "@codegraph/analysis-model";

/**
 * How a repository MOVED since its previous index.
 *
 * A fleet ranked by absolute health answers "who is worst", which nobody can act on —
 * the worst repo is usually the same repo it was last week. Movement is the actionable
 * reading, so both list views rank by this and keep the mean as a footnote.
 *
 * `scoreDelta`/`findingsDelta` are null for a repo indexed ONCE. Null is rendered as
 * "first index"; substituting zero would claim a comparison that was never made and
 * would sort a new repository in with the ones that genuinely did not budge.
 */
export interface RepoDrift {
  /** Findings recorded by the latest run. */
  findings: number;
  /** Latest minus previous. Positive = the score went UP. */
  scoreDelta: number | null;
  /** Latest minus previous. Positive = MORE findings, which is the bad direction. */
  findingsDelta: number | null;
  /** The last index attempt failed. Ranks above every mover. */
  failed: boolean;
}

export type JobStatus = "queued" | "cloning" | "indexing" | "scoring" | "done" | "error";



// --- Enterprise Fleet Graph (Cross-Repo) ---
export interface FleetNode {
  id: string; // repo id
  name: string;
  url: string;
  score: number | null;
  sourceType: SourceType;
  loc: number;
  /** Movement since the previous index. Absent only for a repo with no recorded run. */
  drift: RepoDrift | null;
  /** Latest run's walk stopped at `CG_MAX_FILES` — see `RepoSummary.capHit`. */
  capHit?: boolean;
}
export interface FleetEdge {
  source: string; // repo id
  target: string; // repo id
}
/** A fleet node plus the dependency names its outgoing edges are derived from. */
export interface FleetRepo extends FleetNode {
  dependencies: string[];
  /**
   * The package names this repository's own manifests DECLARE, not its display name.
   *
   * A cross-repository edge is "repo A depends on a package repo B publishes", and those two
   * names are almost never the same string: this monorepo is displayed as `CodeGraph` and
   * publishes `@codegraph/analysis`. Matching on the display name found nothing, which is how
   * the fleet graph came to report 12 repositories and 0 edges while `/api/org` - a second
   * implementation of the same idea, keyed correctly - found 14.
   */
  packageNames: string[];
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
  drift: RepoDrift | null;
  /**
   * The latest run's walk stopped at `CG_MAX_FILES`, so `score` was computed over a SAMPLE.
   *
   * Carried on the summary — not just on `RepoDetail.coverage` — because the dashboard and the
   * fleet index rank repositories against one another by score, and a sampled score sitting in
   * that ranking unmarked reads as a whole-repository one. Optional for the same reason
   * `coverage` is: a run that recorded no coverage cannot say either way, and absent means
   * UNKNOWN rather than "the walk finished".
   */
  capHit?: boolean;
}

export interface RepoDetail extends RepoSummary {
  hasWorkspace: boolean;
  error: string | null;
  loc: number;
  languages: LanguageStat[];
  graphStats: GraphStats;
  dimensions: DimensionScore[];
  /**
   * What the scan looked at (ADR-008). Joined from the latest run, absent for repos indexed
   * before coverage was recorded — the UI renders absent as UNKNOWN, never as complete.
   */
  coverage?: ScanCoverage;
  issues: Issue[];
  dependencies: string[]; // actual package names this repo depends on
  churnByFile: Record<string, number>;
  tree: TreeNode;
  viz: VizGraph;
  modules: ModuleGraph;
  symbolGraph: SymbolGraph;
  /**
   * Analyses added after the first release, joined from the latest run.
   *
   * Optional for the reason `coverage` above is: a repo indexed before one of these existed
   * has no value to join, and ABSENT must render as "not analysed — re-index" rather than as
   * an empty result. A repo that WAS analysed and genuinely has nothing carries a present
   * report with empty arrays, which is a different and much stronger statement.
   */
  ownership?: OwnershipReport;
  apiSurface?: ApiSurface;
  taint?: TaintReport;
  unusedDependencies?: readonly UnusedDependency[];
  advisories?: AdvisoryReport;
  /** Names this repo's manifests declare — what it publishes. Feeds the cross-repo graph. */
  packageNames?: readonly string[];
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
  /**
   * What the pipeline is doing right now, between the coarse steps `progress` counts.
   * Null for a queued job, a finished one, and any job whose stage reports no detail.
   */
  phase: IndexPhase | null;
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
