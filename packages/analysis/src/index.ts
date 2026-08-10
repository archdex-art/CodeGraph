/**
 * `@codegraph/analysis` — TRANSITIONAL. See README.md.
 *
 * The v1 analysis pipeline, moved out of `apps/web/src/lib` unchanged (LLD §13.2)
 * so that `apps/worker` can run it without importing `apps/web`, which
 * `no-cross-app-imports` forbids.
 *
 * P3 splits this package four ways per the `lib/indexer.ts` row of §13's migration
 * map: `pipeline/enumerate`, `lang-*`, `detect-engine`, `score-engine`, `viz`.
 * Nothing here should be treated as a settled boundary.
 */

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
export { DIMENSION_META } from "@codegraph/analysis-model";

export type { PipelineContext } from "./context";
export { throwIfAborted } from "./context";
export { indexRepo } from "./indexer";
export { scoreIssues, expectedHarm } from "@codegraph/score-engine";

export type { EslintSecurityFinding } from "@codegraph/detect-engine";
export { lintForSecurity } from "@codegraph/detect-engine";

// The pure half of baseline handling. `apps/cli` reads a caller-named path and the pipeline
// reads the repo root; both must agree on what a valid baseline IS, so exactly one parser.
export { BASELINE_FILE, parseBaseline } from "./baseline";

/**
 * Dependency intelligence and vulnerability advisories.
 *
 * Exported because `apps/web` serves them on a route and `apps/cli` may gate on them — both
 * are outside this package and neither may reach into `src/` directly.
 */
export { findUnusedDependencies, replacementImpact } from "./depintel";
export type {
  DependencyScope,
  PackageImportSite,
  ReplacementImpact,
  UnusedDependency,
} from "./depintel";
export { disabledReport, fetchAdvisories, osvTransport, resolvePackages } from "./advisories";
export type { Advisory, AdvisoryReport, OsvTransport, ResolvedPackage } from "./advisories";
