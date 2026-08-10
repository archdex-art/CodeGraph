import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";
import { QueryEngine } from "../src/query";

/**
 * Recursion as a first-class call edge.
 *
 * Call-site attribution excluded the callee from its own candidate set, so a recursive call
 * fell through to the next-outer execution context. Measured on a four-function fixture, the
 * result was not "no edge" but a WRONG edge: `<module> -calls-> fact`, a synthetic module node
 * nothing else needed, `fact` carrying a fan-in from a caller that does not exist, and
 * `cycles()` reporting nothing for a function that plainly calls itself — while its own
 * docstring promised "SCCs of size>1 or self-loops".
 *
 * Every case here fails if the exclusion is restored.
 */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

const SRC = [
  "export function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }",
  "export function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1); }",
  "export function fact(n: number): number { if (n <= 1) return 1; return n * fact(n - 1); }",
  "export function caller() { return fact(5); }",
  "export function lonely(n: number): number { return n <= 0 ? 0 : lonely(n - 1); }",
  "",
].join("\n");

describe("recursive call attribution", () => {
  it("attributes a self-call to the function itself, not to module scope", async () => {
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    const fact = g.symbols.find((s) => s.name === "fact")!;
    expect(g.edges).toContainEqual({ source: fact.id, target: fact.id, kind: "calls" });
  });

  it("invents no module node for a file whose only unattributed call was recursion", async () => {
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    expect(g.symbols.filter((s) => s.kind === "module")).toHaveLength(0);
  });

  it("counts only real external callers in fan-in", async () => {
    // `fact` is called by `caller` and by itself. One of those is a dependant; the other is
    // the same function. Fan-in answers "who else depends on this", so it must be 1 — the
    // module-scope misattribution used to make it 2.
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    expect(g.symbols.find((s) => s.name === "fact")!.fanIn).toBe(1);
  });

  it("still reports a recursive-but-unreferenced function as dead code", async () => {
    // The regression this guards: crediting the self-edge to fan-in would let any recursive
    // function mark its own homework and vanish from the dead-code list.
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    expect(new QueryEngine(g).deadCode().map((s) => s.name)).toContain("lonely");
  });

  it("reports direct recursion as a cycle", async () => {
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    const named = new QueryEngine(g).cycles();
    expect(named).toContainEqual(["fact"]);
    expect(named).toContainEqual(["lonely"]);
  });

  it("still reports mutual recursion as one cycle", async () => {
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    const cycle = new QueryEngine(g).cycles().find((c) => c.length > 1)!;
    expect([...cycle].sort()).toEqual(["isEven", "isOdd"]);
  });

  it("does not report a non-recursive function as a one-node cycle", async () => {
    // The obvious wrong fix — pushing every singleton component — would report all five.
    const g = await buildSymbolGraph([f("r.ts", SRC)], new Map());
    expect(new QueryEngine(g).cycles()).not.toContainEqual(["caller"]);
  });
});
