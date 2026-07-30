/**
 * Re-export shim (LLD §13.1 step 1, §13.2).
 *
 * Moved to `@codegraph/core-graph` — interim home, not the final one: §13 routes
 * these to `lang-typescript`/`lang-python` in P3. They could not stay behind in
 * `analysis` because `graph.ts` consumes `extractorFor` while `indexer.ts`
 * consumes `graph.ts`, which would make the two packages cyclic.
 */
export type {
  ExtractContext,
  ExtractResult,
  LanguageExtractor,
  RawImport,
  RawReference,
  RawSymbol,
} from "@codegraph/core-graph";
export { extractorFor, supportedExts } from "@codegraph/core-graph";
