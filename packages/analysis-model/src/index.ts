/**
 * `@codegraph/analysis-model` — the v1 analysis output models. TRANSITIONAL.
 *
 * Zero runtime dependencies, and that is the entire point: this package exists
 * because the model has to be importable from BOTH the analysis pipeline (Node,
 * uses `child_process` and `fs`) and React client components.
 *
 * It was carved out of `@codegraph/analysis` after a build failure proved the
 * need rather than after arguing about it. `apps/web/src/lib/types.ts` re-exports
 * `DIMENSION_META`, which is a *value*, so Turbopack has to resolve the module it
 * comes from. With the model inside the pipeline package, that dragged
 * `node:child_process` (via `vcs`) and `fs` (via `eslint`'s `fdir`) into the
 * client graph, and the build failed with "the chunking context does not support
 * external modules".
 *
 * Splitting `DIMENSION_META` itself was the obvious alternative and it is wrong:
 * the report UI renders `weight {Math.round(meta.weight * 100)}%` next to each
 * dimension, so the weights are user-visible — that is IDENTITY.md §1's
 * explainable Health Score, not an internal detail. The table is legitimately one
 * thing shared by the scorer and the UI, so it needs a client-safe home rather
 * than a division.
 *
 * WHAT REPLACES IT. P3 migrates callers onto `@codegraph/core-domain`'s v2 model,
 * which already exists and already differs — `Dimension` there has six members
 * including `"performance"`, this one has five. That is a scoring change (the five
 * weights sum to exactly 1.0), so it needs the design question answered first:
 * does `performance` earn weight, and taken from where? Until then the two coexist
 * deliberately. See LLD §13.2.
 */

export type {
  Dimension,
  FileSignals,
  Pillar,
  PillarScore,
  ScanCoverage,
  ScannedFile,
  DimensionScore,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  GraphStats,
  IncrementalReport,
  IndexResult,
  Issue,
  LanguageStat,
  ModuleEdge,
  ModuleGraph,
  ModuleNode,
  TreeNode,
  VizGraph,
} from "./models";
export {
  DIMENSION_META,
  DIMENSION_PILLAR,
  PILLAR_META,
  pillarsFrom,
  weightWithinPillar,
} from "./models";
export { toSarif, sarifRuleId } from "./sarif";
export type { SarifLog, SarifOptions } from "./sarif";
export { LANG_BY_EXT, CODE_EXTS } from "./models";
export { throwIfAborted, yieldToEventLoop, timeStage, YIELD_EVERY } from "./pipeline";
export type { IndexCacheStore, PipelineContext, StageTimings } from "./pipeline";
