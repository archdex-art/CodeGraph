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

export { indexRepo, scoreIssues } from "./indexer";

export type { EslintSecurityFinding } from "./eslintSecurity";
export { lintForSecurity } from "./eslintSecurity";
