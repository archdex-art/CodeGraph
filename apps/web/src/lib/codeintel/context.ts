import type { AIContext, CodeSymbol, ContextSlice, SymbolGraph } from "../types";
import { QueryEngine } from "./query";

// ~4 chars/token heuristic.
const estTokens = (s: string) => Math.ceil(s.length / 4);

interface BuildOpts {
  tokenBudget?: number; // default 3000
  maxSymbols?: number; // default 24
}

/**
 * Escape text for safe embedding inside the assembled XML-tagged prompt.
 * Real signatures/docstrings routinely contain `<`, `>`, `&`, `"` — generics
 * (`Record<string, T>`), intersection types (`A & B`), or literal HTML/quotes
 * in a comment — which would otherwise corrupt the tag structure of the
 * context handed to a downstream LLM or any strict XML/HTML consumer.
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Graph-RAG context builder.
 * 1. Seed: rank symbols against the query (name/tag/doc + centrality).
 * 2. Expand: pull callees (dependencies the code needs) + top callers (usage sites) + siblings.
 * 3. Budget: greedily fill a token budget by descending relevance, deduped — using the
 *    SAME rendered XML block that lands in the final prompt, so `tokenBudget` is honored
 *    (tag/attribute overhead was previously excluded from the budgeting pass, letting the
 *    real prompt run meaningfully over the requested budget).
 * 4. Assemble: structured, escaped, LLM-friendly prompt with provenance.
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

  // Rank and token-budget against the real rendered block for each slice.
  const ranked = [...slices.values()].sort((a, b) => b.score - a.score);
  const chosen: ContextSlice[] = [];
  const blocks = new Map<string, string>();
  let tokens = 0;
  let truncated = false;
  for (const slice of ranked) {
    if (chosen.length >= maxSymbols) { truncated = true; break; }
    const block = symbolBlock(slice.symbol, slice.reason);
    const t = estTokens(block);
    if (tokens + t > tokenBudget) { truncated = true; continue; }
    tokens += t;
    blocks.set(slice.symbol.id, block);
    chosen.push(slice);
  }

  const prompt = assemble(query, chosen, blocks);
  return {
    query,
    seeds: seeds.map((s) => s.id),
    slices: chosen,
    prompt,
    tokenEstimate: estTokens(prompt),
    truncated,
  };
}

/** Render one symbol as the exact `<symbol>` XML block that lands in the final prompt
 *  (shared by the budgeting pass and `assemble()` so the two never diverge). */
function symbolBlock(s: CodeSymbol, role: string): string {
  const attrs = [
    `kind="${escapeXml(s.kind)}"`,
    `name="${escapeXml(s.name)}"`,
    `line="${s.line}"`,
    `role="${escapeXml(role)}"`,
  ];
  if (s.exported) attrs.push(`exported="true"`);
  const lines = [`    <symbol ${attrs.join(" ")}>`];
  if (s.doc) lines.push(`      <doc>${escapeXml(s.doc)}</doc>`);
  lines.push(`      <signature>${escapeXml(s.signature)}</signature>`);
  if (s.fanIn || s.fanOut) lines.push(`      <graph callers="${s.fanIn}" callees="${s.fanOut}"/>`);
  lines.push(`    </symbol>`);
  return lines.join("\n");
}

function assemble(query: string, slices: ContextSlice[], blocks: Map<string, string>): string {
  const byFile = new Map<string, ContextSlice[]>();
  for (const sl of slices) {
    const l = byFile.get(sl.symbol.file) || [];
    l.push(sl);
    byFile.set(sl.symbol.file, l);
  }

  const parts: string[] = [];
  parts.push(`<task>${escapeXml(query)}</task>`);
  parts.push(`<codegraph_context symbols="${slices.length}">`);
  parts.push(
    `<!-- Assembled by CodeGraph Graph-RAG: seeds ranked by relevance, expanded along call/containment edges. -->`
  );
  for (const [file, group] of byFile) {
    parts.push(`  <file path="${escapeXml(file)}">`);
    for (const sl of group.sort((a, b) => a.symbol.line - b.symbol.line)) {
      parts.push(blocks.get(sl.symbol.id)!);
    }
    parts.push(`  </file>`);
  }
  parts.push(`</codegraph_context>`);
  return parts.join("\n");
}
