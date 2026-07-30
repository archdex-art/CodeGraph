/**
 * The symbol-graph model.
 *
 * Moved verbatim from `apps/web/src/lib/types.ts` (LLD §13.2). These five types
 * are exactly what §3 names as this package's charter, and `graph.ts`,
 * `query.ts`, and `extractors.ts` are their only consumers, so they travel
 * together rather than staying behind in the app's view-model module.
 *
 * TRANSITIONAL SHAPE. §3 specifies a richer model for these — `Sym` with a
 * branded `SymbolId`, `Edge` with a `resolution: "exact" | "heuristic" |
 * "dynamic"` discriminant, and `ProgramGraph` with a query surface including
 * `reachableCallers` and uncapped `cycles()`. Adopting that is P3 work: the
 * `resolution` field in particular is meaningless until `lang-typescript`
 * reaches `full` tier, because today every edge would be tagged `heuristic`.
 * What moved here is the v1 shape, unchanged, so that P2 makes no behaviour
 * change; P3 replaces it in place, which is the point of putting it behind this
 * package's boundary now.
 */

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
  loc: number; // approximate lines of code for the symbol itself
  complexity?: number; // cyclomatic/branching complexity (if computable)
  language: string;
  container: string | null; // enclosing symbol id (method -> class)
  fanIn: number; // resolved incoming references (callers)
  fanOut: number; // resolved outgoing references (callees)
  issues: number;
  tags: string[]; // semantic tags (auth, db, http, test, …)
}

export type SymbolEdgeKind =
  | "calls"
  | "references"
  | "contains"
  | "imports"
  | "extends"
  | "implements";

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

/** AI context (Graph-RAG) output. Consumed by the context builder. */
export interface ContextSlice {
  symbol: CodeSymbol;
  reason: string; // why included: "seed" | "caller" | "callee" | "sibling" | "import"
  score: number;
}
