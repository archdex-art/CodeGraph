import { describe, expect, it } from "vitest";
import { buildVizGraph } from "../src/viz";
import type { ScannedFile } from "@codegraph/analysis-model";

/**
 * External packages as first-class nodes on the renderable graph.
 *
 * `GraphNodeKind` has listed `"dependency"` and `GraphEdge.kind` `"depends"` since the model
 * was written, and `buildVizGraph` never received the data to produce either: it takes files
 * and INTERNAL import edges. The third-party half arrives separately, so these assertions are
 * about the nodes existing and being attributed to the right file, not about how they render.
 *
 * `@codegraph/imports` owns the specifier-to-package rules and tests them; this package may
 * not depend on it (`.dependency-cruiser.cjs` allows `viz -> analysis-model` only), so the
 * edges are supplied here directly, which is also how the indexer supplies them.
 */
const f = (rel: string, ext: string, loc = 10): ScannedFile => ({ rel, ext, loc, imports: [] } as unknown as ScannedFile);

describe("dependency nodes and depends edges", () => {
  it("emits a dependency node and an edge from the file that imports it", () => {
    const g = buildVizGraph([f("a.ts", ".ts"), f("b.ts", ".ts")], [{ from: "a.ts", to: "b.ts" }], new Map(), [], [
      { from: "a.ts", pkg: "express" },
    ]);
    expect(g.nodes.find((n) => n.id === "dep:express")).toMatchObject({
      kind: "dependency",
      label: "express",
      fanIn: 1,
      // An external package has no lines in THIS repository, and the walk never enters
      // node_modules to find out how many it has elsewhere.
      loc: 0,
    });
    expect(g.edges).toContainEqual({ source: "a.ts", target: "dep:express", kind: "depends" });
    // The internal edge is still an import, not a dependency.
    expect(g.edges).toContainEqual({ source: "a.ts", target: "b.ts", kind: "imports" });
  });

  it("counts fan-in as the number of files that import the package", () => {
    const g = buildVizGraph([f("a.ts", ".ts"), f("b.ts", ".ts")], [], new Map(), [], [
      { from: "a.ts", pkg: "react" },
      { from: "b.ts", pkg: "react" },
    ]);
    expect(g.nodes.find((n) => n.id === "dep:react")!.fanIn).toBe(2);
    expect(g.edges.filter((e) => e.kind === "depends")).toHaveLength(2);
  });

  it("drops an edge whose importing file was cut by the node cap", () => {
    // A dangling edge to a node that is not drawn is a rendering bug; the cap has to apply to
    // the dependency half too, or the graph claims an origin it never placed.
    const g = buildVizGraph([f("kept.ts", ".ts")], [], new Map(), [], [
      { from: "kept.ts", pkg: "express" },
      { from: "not-scanned.ts", pkg: "express" },
    ]);
    expect(g.edges.filter((e) => e.kind === "depends")).toEqual([
      { source: "kept.ts", target: "dep:express", kind: "depends" },
    ]);
    expect(g.nodes.find((n) => n.id === "dep:express")!.fanIn).toBe(1);
  });

  it("stays exactly as it was when no external edges are supplied", () => {
    // The parameter is optional so existing callers keep their behaviour unchanged.
    const g = buildVizGraph([f("a.ts", ".ts")], [], new Map(), []);
    expect(g.nodes.some((n) => n.kind === "dependency")).toBe(false);
    expect(g.edges.some((e) => e.kind === "depends")).toBe(false);
  });
});
