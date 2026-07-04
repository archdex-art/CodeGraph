import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "@/lib/codeintel/graph";
import type { FileInput } from "@/lib/codeintel/graph";
import { QueryEngine } from "@/lib/codeintel/query";
import { buildContext } from "@/lib/codeintel/context";
import type { SymbolGraph } from "@/lib/types";

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

const graph: SymbolGraph = buildSymbolGraph(FILES, new Map());
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
