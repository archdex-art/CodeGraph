/**
 * `@codegraph/core-graph` — the symbol graph and its query surface (LLD §3).
 *
 * Moved from `apps/web/src/lib/codeintel/*` and the symbol-graph half of
 * `lib/types.ts` per LLD §13.2, unchanged. The move is what lets `apps/worker`
 * build a graph without importing `apps/web`, which `no-cross-app-imports`
 * forbids — and that rule is the mechanism making the worker's process boundary
 * structural rather than a convention.
 *
 * WHAT §3 SPECIFIES THAT THIS DOES NOT YET HAVE. §3's model is richer than the v1
 * shape carried over here: branded `SymbolId`s, an `Edge.resolution` discriminant
 * (`"exact" | "heuristic" | "dynamic"`), CFG construction, `reachableCallers`,
 * Tarjan SCC, and an uncapped `cycles()` where v1 caps at `maxReport = 20`. All
 * of that is P3, and deliberately so — `resolution` is not merely unimplemented
 * but currently meaningless, because until `lang-typescript` reaches `full` tier
 * every edge would carry `"heuristic"`. Measured on
 * `expressjs/express@a371447` (`docs/REVIEW_2026-07-29.md`): 11 resolved call
 * edges across 123 symbols. Putting the v1 shape behind this boundary now is what
 * lets P3 replace it in one place instead of across the app.
 *
 * The extractors live here too, which §13 does not ultimately want — they belong
 * in `lang-typescript`/`lang-python`. They cannot move to `analysis` in the
 * meantime without creating `core-graph → analysis → core-graph`; see §13.2.
 */

export type {
  CodeSymbol,
  ContextSlice,
  SymbolEdge,
  SymbolEdgeKind,
  SymbolGraph,
  SymbolKind,
} from "./symbol";

export type { ExtractionRecord, FileInput, SymbolGraphOptions } from "./graph";
export { buildSymbolGraph } from "./graph";

export { QueryEngine } from "./query";

// The extractor contract lives in `./contracts`, not `./extractors`, so that
// `ast-extractor.ts` can depend on it without a cycle (see contracts.ts).
export type {
  ExtractContext,
  ExtractResult,
  LanguageExtractor,
  RawImport,
  RawReference,
  RawSymbol,
} from "./contracts";
export { extractorFor, supportedExts } from "./extractors";

export type { RawSymbolExtended } from "./ast-extractor";
export { astTsExtractor, initTreeSitter } from "./ast-extractor";

export { syntacticSpans, lexicalSpans, spansFor, contextAt, tierForExt } from "./source-context";
export type { SourceContext, SourceSpan, AnalysisTier } from "./source-context";
export { classifyTaint, callAt } from "./dataflow";
export type { TaintQuery, TaintVerdict } from "./dataflow";
export { ContentCache, contentCache } from "./content-cache";
export type { ContentCacheStats } from "./content-cache";

/**
 * APIs as first-class entities, and inter-procedural taint.
 *
 * Both sit ABOVE the symbol graph rather than inside it: each takes a built `SymbolGraph` and
 * derives from it, so the extractor stays a pure function of a file's bytes and either can be
 * skipped without changing what the graph contains.
 */
export {
  buildApiSurface,
  endpointsAffectedBy,
  extractEndpoints,
  unauthenticatedSinkPaths,
} from "./api";
export type {
  ApiEndpoint,
  ApiMethod,
  ApiSinkKind,
  ApiSourceFile,
  ApiSurface,
  DataFlowPath,
} from "./api";
export { analyseTaint } from "./taint";
export type { AnalysedFile, TaintPath, TaintReport } from "./taint";

/**
 * Deterministic natural-language querying.
 *
 * Sits above everything else here: a question compiles into the operations already exported
 * from this package, so the surface adds a parser and a set of answer templates, never a new
 * source of facts. `AskPlan` travels with every answer because a query surface that cannot
 * show what it ran is indistinguishable from one that guessed.
 */
export { ask, compileAsk } from "./ask";
export type {
  AskAnswer,
  AskCorpus,
  AskEntity,
  AskEntityKind,
  AskFailure,
  AskIntent,
  AskPlan,
  AskResult,
  AskRow,
} from "./ask";
