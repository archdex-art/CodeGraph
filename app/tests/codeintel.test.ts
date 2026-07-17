import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "@/lib/codeintel/graph";
import type { FileInput } from "@/lib/codeintel/graph";
import { QueryEngine } from "@/lib/codeintel/query";
import { buildContext } from "@/lib/codeintel/context";
import type { CodeSymbol, SymbolGraph } from "@/lib/types";

// In-memory files forming a call chain: alpha -> beta -> gamma.
const FILES: FileInput[] = [
  {
    rel: "a.ts",
    ext: ".ts",
    language: "TypeScript",
    text: ["export function alpha() {", "  beta();", "  return gamma();", "}", ""].join("\n"),
  },
  {
    rel: "b.ts",
    ext: ".ts",
    language: "TypeScript",
    text: ["export function beta() {", "  return gamma();", "}", ""].join("\n"),
  },
  {
    rel: "c.ts",
    ext: ".ts",
    language: "TypeScript",
    text: ["export function gamma() {", "  return 1;", "}", ""].join("\n"),
  },
];

const graph: SymbolGraph = await buildSymbolGraph(FILES, new Map());
const idOf = (name: string): string => {
  const s = graph.symbols.find((x) => x.name === name);
  if (!s) throw new Error(`symbol ${name} not found`);
  return s.id;
};

describe("buildSymbolGraph", () => {
  it("extracts all three functions", () => {
    const names = graph.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
    expect(graph.stats.symbols).toBe(3);
  });

  it("resolves cross-file calls into edges", () => {
    expect(graph.stats.resolvedCalls).toBeGreaterThan(0);
    const calls = graph.edges.filter((e) => e.kind === "calls");
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("QueryEngine", () => {
  const qe = new QueryEngine(graph);

  it("search ranks an exact name match first", () => {
    const hits = qe.search("beta");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe("beta");
  });

  it("callees returns downstream symbols", () => {
    const callees = qe.callees(idOf("alpha")).map((s) => s.name);
    expect(callees).toContain("beta");
    expect(callees).toContain("gamma");
  });

  it("callers returns upstream symbols", () => {
    const callers = qe.callers(idOf("gamma")).map((s) => s.name);
    expect(callers).toContain("beta");
  });
});

describe("buildContext", () => {
  it("assembles a Graph-RAG prompt with slices for a matching query", () => {
    const ctx = buildContext(graph, "beta");
    expect(typeof ctx.prompt).toBe("string");
    expect(ctx.prompt).toContain("<task>");
    expect(ctx.prompt).toContain("beta");
    expect(ctx.slices.length).toBeGreaterThan(0);
  });
});

describe("buildContext - XML escaping", () => {
  // A symbol whose real-world doc/signature carry exactly the characters that
  // corrupt naive string interpolation into an XML-tagged template: generics
  // and intersection types in the signature, literal HTML + quotes in the doc.
  const weird: CodeSymbol = {
    id: "weird.ts#weirdFn@1",
    name: "weirdFn",
    kind: "function",
    file: "weird.ts",
    line: 1,
    endLine: 5,
    signature: "function weirdFn<T extends Record<string, unknown>>(x: T): T & { ok: boolean }",
    doc: 'Handles <script> tags & "quoted" strings safely.',
    exported: true,
    language: "TypeScript",
    loc: 5,
    container: null,
    fanIn: 0,
    fanOut: 0,
    issues: 0,
    tags: [],
  };
  const escGraph: SymbolGraph = {
    symbols: [weird],
    edges: [],
    truncated: false,
    stats: { symbols: 1, edges: 0, resolvedCalls: 0 },
  };
  // Contains < and & itself, so the <task> tag is exercised too.
  const query = "how does <Foo> weirdFn handle & validate?";

  it("never lets raw <, >, & from doc/signature/query corrupt the XML tag structure", () => {
    const ctx = buildContext(escGraph, query);

    expect(ctx.prompt).not.toContain("<script>");
    expect(ctx.prompt).not.toContain("<T ");
    expect(ctx.prompt).not.toContain(" & ");
    expect(ctx.prompt).not.toContain("<Foo>");
  });

  it("renders the escaped forms in their place so the content is still legible", () => {
    const ctx = buildContext(escGraph, query);

    expect(ctx.prompt).toContain("&lt;script&gt;");
    expect(ctx.prompt).toContain("&lt;T");
    expect(ctx.prompt).toContain("&amp;");
    expect(ctx.prompt).toContain("&lt;Foo&gt;");
  });

  it("escapes literal double quotes to &quot; inside <doc>/<signature> element text", () => {
    const ctx = buildContext(escGraph, query);
    expect(ctx.prompt).toContain("&quot;quoted&quot;");
  });

  it("keeps plain identifiers and paths unescaped so the prompt stays useful", () => {
    const ctx = buildContext(escGraph, query);
    expect(ctx.prompt).toContain("weirdFn");
    expect(ctx.prompt).toContain("weird.ts");
    expect(ctx.prompt).toContain('name="weirdFn"');
  });
});

describe("buildContext - token budgeting", () => {
  // A chain of 8 symbols, chainN calls chain(N+1). Query "chain" seeds
  // chain1..chain5 (highest fanIn/name-match score); expansion along
  // callee/caller edges pulls in chain6 and chain0, for a candidate pool
  // of 7 (chain7 is never reached: it's two hops from every seed).
  const N = 8;
  const chainSymbols: CodeSymbol[] = Array.from({ length: N }, (_, i) => ({
    id: `chain.ts#chain${i}@${i + 1}`,
    name: `chain${i}`,
    kind: "function",
    file: "chain.ts",
    line: i + 1,
    endLine: i + 3,
    signature: `function chain${i}(x: number): number`,
    doc: `Step ${i} of the pipeline.`,
    exported: true,
    language: "TypeScript",
    loc: 3,
    container: null,
    fanIn: i >= 1 ? 1 : 0,
    fanOut: i < N - 1 ? 1 : 0,
    issues: 0,
    tags: ["chain"],
  }));
  const chainGraph: SymbolGraph = {
    symbols: chainSymbols,
    edges: chainSymbols.slice(0, N - 1).map((s, i) => ({
      source: s.id,
      target: chainSymbols[i + 1].id,
      kind: "calls",
    })),
    truncated: false,
    stats: { symbols: N, edges: N - 1, resolvedCalls: N - 1 },
  };

  it("reports a tokenEstimate that truthfully reflects the assembled prompt's length", () => {
    const generous = buildContext(chainGraph, "chain", { tokenBudget: 5000, maxSymbols: 20 });
    const small = buildContext(chainGraph, "chain", { tokenBudget: 150, maxSymbols: 20 });

    expect(Math.ceil(generous.prompt.length / 4)).toBe(generous.tokenEstimate);
    expect(Math.ceil(small.prompt.length / 4)).toBe(small.tokenEstimate);
  });

  it("honors a small tokenBudget by dropping symbols instead of silently overshooting", () => {
    const generous = buildContext(chainGraph, "chain", { tokenBudget: 5000, maxSymbols: 20 });
    const small = buildContext(chainGraph, "chain", { tokenBudget: 150, maxSymbols: 20 });

    // Full candidate pool (nothing dropped for lack of budget) has 7 members.
    expect(generous.truncated).toBe(false);
    expect(generous.slices.length).toBeGreaterThan(0);

    // The tiny budget must actually bite: fewer slices survive and the
    // result is flagged truncated.
    expect(small.truncated).toBe(true);
    expect(small.slices.length).toBeLessThan(generous.slices.length);

    // The real, final prompt (same XML the budgeting loop measured — no
    // separate cheaper approximation) must stay close to the requested
    // budget: a little header/wrapper overhead is expected, but nowhere
    // near the ~3x overshoot the old split render/budget approximation
    // produced for this fixture.
    expect(small.tokenEstimate).toBeLessThanOrEqual(150 + 100);
  });
});
