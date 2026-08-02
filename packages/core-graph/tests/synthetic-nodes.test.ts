import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";
import { QueryEngine } from "../src/query";

/**
 * Synthetic `<module>` nodes must answer relation questions and stay out of enumeration.
 *
 * They were added so a call made outside any named function still has a source. Measured on
 * this repository right after: `search("module")` returned **21 of 30** synthetic nodes,
 * `hubs()` ranked one in the top three, and `symbolAt(file, 1)` preferred the zero-width module
 * node over a function starting on line 1 - it picks the smallest enclosing span, and nothing
 * is smaller than nothing.
 *
 * The rule: a node the user did not write is a legitimate ANSWER about the graph and never an
 * ITEM in a list of their code.
 */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

const withModuleCall = () =>
  buildSymbolGraph(
    [f("m.ts", "export function first() {\n  return 1;\n}\nconst _ = first();\n")],
    new Map(),
  );

describe("synthetic module nodes", () => {
  it("still answers 'who calls this'", async () => {
    // Their entire reason for existing. If this breaks, the node is pure noise.
    const g = await withModuleCall();
    const qe = new QueryEngine(g);
    const first = g.symbols.find((s) => s.name === "first")!;
    expect(qe.callers(first.id).map((s) => s.kind)).toContain("module");
  });

  it("does not appear in search results", async () => {
    const g = await withModuleCall();
    expect(new QueryEngine(g).search("module")).toHaveLength(0);
  });

  it("does not win symbolAt against a function starting on the same line", async () => {
    // The zero-width span always looked "smallest". A finding on line 1 attributed to
    // `<module>` instead of the function containing it.
    const g = await withModuleCall();
    expect(new QueryEngine(g).symbolAt("m.ts", 1)?.name).toBe("first");
  });

  it("does not rank as a hub", async () => {
    // A module that calls ten functions is not a hub anyone can act on.
    const g = await withModuleCall();
    expect(new QueryEngine(g).hubs(10).some((s) => s.kind === "module")).toBe(false);
  });

  it("is still present in the graph itself", async () => {
    // Excluded from enumeration, NOT deleted - the edge needs a real source node.
    const g = await withModuleCall();
    expect(g.symbols.some((s) => s.kind === "module")).toBe(true);
  });
});
