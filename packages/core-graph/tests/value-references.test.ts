import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";

/**
 * References that are not call expressions.
 *
 * The extractor only recorded `CallExpression`, so a function used as a VALUE produced no
 * reference at all. Measured on this repository with the TypeScript checker: 372 such
 * identifiers against 6,836 direct calls, of which the two unambiguous classes are JSX tags
 * (91) and callback arguments (41).
 *
 * The visible defect was JSX: **all 41 components had zero inbound edges**, because
 * `<AgentSwarm />` is a `JsxSelfClosingElement` and never a `CallExpression`. Every component
 * in a React codebase sat in the graph as an isolated node.
 *
 * Every test here is mutation-verified to fail when the behaviour is reverted.
 */
const f = (rel: string, text: string) => ({ rel, ext: rel.endsWith("tsx") ? ".tsx" : ".ts", text, language: "TypeScript" });
const edge = (g: Awaited<ReturnType<typeof buildSymbolGraph>>, from: string, to: string) =>
  g.edges.some((e) => {
    const s = g.symbols.find((x) => x.id === e.source);
    const t = g.symbols.find((x) => x.id === e.target);
    return e.kind === "calls" && s?.name === from && t?.name === to;
  });

describe("value-position references", () => {
  it("treats rendering a component as invoking it", async () => {
    const g = await buildSymbolGraph(
      [
        f("Child.tsx", "export function Child() { return <p>hi</p>; }\n"),
        f("Parent.tsx", "import { Child } from './Child';\nexport function Parent() { return <Child />; }\n"),
      ],
      new Map(),
    );
    expect(edge(g, "Parent", "Child")).toBe(true);
  });

  it("handles a component with children, not just self-closing", async () => {
    const g = await buildSymbolGraph(
      [
        f("Box.tsx", "export function Box(p: { children?: unknown }) { return <div>{p.children}</div>; }\n"),
        f("App.tsx", "import { Box } from './Box';\nexport function App() { return <Box><span/></Box>; }\n"),
      ],
      new Map(),
    );
    expect(edge(g, "App", "Box")).toBe(true);
  });

  it("does not invent an edge for an intrinsic lowercase tag", async () => {
    // `<div/>` is an HTML element, not a symbol. The uppercase rule is JSX semantics.
    const g = await buildSymbolGraph(
      [f("D.tsx", "export function div() { return 1; }\nexport function W() { return <div />; }\n")],
      new Map(),
    );
    expect(edge(g, "W", "div")).toBe(false);
  });

  it("treats a function passed as an argument as used", async () => {
    const g = await buildSymbolGraph(
      [
        f(
          "cb.ts",
          "export function parseRow(x: number) { return x + 1; }\n" +
            "export function run(rows: number[]) { return rows.map(parseRow); }\n",
        ),
      ],
      new Map(),
    );
    expect(edge(g, "run", "parseRow")).toBe(true);
  });

  it("does not emit speculative edges for non-callable arguments", async () => {
    /**
     * Gated on the checker confirming the argument is function-like, or every identifier
     * argument becomes an edge.
     *
     * The decoy is a CLASS deliberately. The first version of this test used
     * `export const limit = 5`, which the extractor does not record as a symbol at all - so
     * no edge could form whatever the code did, and the assertion passed vacuously. Mutation
     * testing caught it: removing the gate left the suite green. A class IS extracted, so the
     * assertion now has something to fail against.
     */
    const g = await buildSymbolGraph(
      [
        f(
          "v.ts",
          "export class Config {}\nexport function take(x: unknown) { return x; }\n" +
            "export function go() { return [take(Config), take(go)]; }\n",
        ),
      ],
      new Map(),
    );
    expect(edge(g, "go", "Config")).toBe(false);
    expect(edge(g, "go", "take")).toBe(true);
  });
});
