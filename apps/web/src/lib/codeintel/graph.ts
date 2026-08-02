/**
 * Re-export shim (LLD §13.1 step 1, §13.2).
 *
 * The symbol graph moved to `@codegraph/core-graph` so `apps/worker` can build
 * one without importing `apps/web`. Existing importers keep working through this
 * path; the shim is deleted in §13.1 step 3 once none remain.
 */
export type { FileInput } from "@codegraph/core-graph";
export { buildSymbolGraph } from "@codegraph/core-graph";
