import type { AIContext, CodeSymbol, ContextSlice, SymbolGraph } from "../types";
import { QueryEngine } from "./query";

// ~4 chars/token heuristic.
const estTokens = (s: string) => Math.ceil(s.length / 4);

interface BuildOpts {
  tokenBudget?: number; // default 3000
  maxSymbols?: number; // default 24
}

/**
 * Graph-RAG context builder.
 * 1. Seed: rank symbols against the query (name/tag/doc + centrality).
 * 2. Expand: pull callees (dependencies the code needs) + top callers (usage sites) + siblings.
 * 3. Budget: greedily fill a token budget by descending relevance, deduped.
 * 4. Assemble: structured, LLM-friendly prompt with provenance.
 */
export function buildContext(graph: SymbolGraph, query: string, opts: BuildOpts = {}): AIContext {
  const tokenBudget = opts.tokenBudget ?? 3000;
  const maxSymbols = opts.maxSymbols ?? 24;
  const qe = new QueryEngine(graph);

  // Tokenize the task: try the whole phrase, then per-keyword (skip stopwords) so
  // "render a view template" seeds on render/view/template, not the literal phrase.
  const STOP: Record<string, true> = { a: true, an: true, the: true, to: true, and: true, or: true, of: true, in: true, on: true, for: true, with: true, my: true, is: true, this: true, that: true, code: true, function: true, please: true };
  const keywords = query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP[w]);
  const seedMap = new Map<string, CodeSymbol>();
  for (const s of qe.search(query, 5)) seedMap.set(s.id, s);
  for (const kw of keywords) {
    for (const s of qe.search(kw, 3)) if (!seedMap.has(s.id)) seedMap.set(s.id, s);
  }
  const seeds = [...seedMap.values()].slice(0, 8);
  const slices = new Map<string, ContextSlice>();

  const add = (s: CodeSymbol, reason: string, score: number) => {
    const cur = slices.get(s.id);
    if (!cur || score > cur.score) slices.set(s.id, { symbol: s, reason, score });
  };

  seeds.forEach((s, i) => add(s, "seed", 100 - i * 5));

  // Expand each seed along the graph.
  for (const seed of seeds) {
    for (const callee of qe.callees(seed.id)) add(callee, "callee (dependency)", 70);
    for (const caller of qe.callers(seed.id).slice(0, 4)) add(caller, "caller (usage)", 55);
    if (seed.container) {
      const parent = qe.get(seed.container);
      if (parent) {
        add(parent, "container", 60);
        for (const sib of qe.members(parent.id).slice(0, 4)) add(sib, "sibling", 40);
      }
    }
    for (const m of qe.members(seed.id).slice(0, 6)) add(m, "member", 65);
  }

  // Rank and token-budget.
  const ranked = [...slices.values()].sort((a, b) => b.score - a.score);
  const chosen: ContextSlice[] = [];
  let tokens = 0;
  let truncated = false;
  for (const slice of ranked) {
    if (chosen.length >= maxSymbols) { truncated = true; break; }
    const block = renderSymbol(slice.symbol);
    const t = estTokens(block);
    if (tokens + t > tokenBudget) { truncated = true; continue; }
    tokens += t;
    chosen.push(slice);
  }

  const prompt = assemble(query, chosen);
  return {
    query,
    seeds: seeds.map((s) => s.id),
    slices: chosen,
    prompt,
    tokenEstimate: estTokens(prompt),
    truncated,
  };
}

function renderSymbol(s: CodeSymbol): string {
  const doc = s.doc ? `  // ${s.doc}\n` : "";
  return `${doc}  ${s.signature}  [${s.file}:${s.line}${s.tags.length ? " · " + s.tags.join(",") : ""}]`;
}

function assemble(query: string, slices: ContextSlice[]): string {
  const byFile = new Map<string, ContextSlice[]>();
  for (const sl of slices) {
    const l = byFile.get(sl.symbol.file) || [];
    l.push(sl);
    byFile.set(sl.symbol.file, l);
  }

  const parts: string[] = [];
  parts.push(`<task>${query}</task>`);
  parts.push(`<codegraph_context symbols="${slices.length}">`);
  parts.push(
    `<!-- Assembled by CodeGraph Graph-RAG: seeds ranked by relevance, expanded along call/containment edges. -->`
  );
  for (const [file, group] of byFile) {
    parts.push(`  <file path="${file}">`);
    for (const sl of group.sort((a, b) => a.symbol.line - b.symbol.line)) {
      const s = sl.symbol;
      parts.push(`    <symbol kind="${s.kind}" name="${s.name}" line="${s.line}" role="${sl.reason}"${s.exported ? ' exported="true"' : ""}>`);
      if (s.doc) parts.push(`      <doc>${s.doc}</doc>`);
      parts.push(`      <signature>${s.signature}</signature>`);
      if (s.fanIn || s.fanOut) parts.push(`      <graph callers="${s.fanIn}" callees="${s.fanOut}"/>`);
      parts.push(`    </symbol>`);
    }
    parts.push(`  </file>`);
  }
  parts.push(`</codegraph_context>`);
  return parts.join("\n");
}
