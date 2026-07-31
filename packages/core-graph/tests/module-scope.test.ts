import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";
import { QueryEngine } from "../src/query";

/**
 * Module scope as a caller.
 *
 * Call-site attribution used to be a PARTIAL function: only a call lexically inside a named
 * function/method/component produced an edge. Everything else was dropped. Measured on this
 * repository: **2,313 of 5,025 resolved calls (46%)** were discarded, and a function called
 * only from a top-level statement or a `describe`/`it` callback showed fan-in 0 and was
 * reported as dead code.
 *
 * Unlike `typed-resolution.test.ts` - whose cases the heuristics satisfy unaided, as its
 * comment says - every test here is mutation-verified to FAIL when the behaviour is reverted.
 */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

describe("module-scope attribution", () => {
  it("attributes a top-level call to the module, not to nothing", async () => {
    const g = await buildSymbolGraph(
      [f("m.ts", "export function greet() { return 'hi'; }\nconst _ = greet();\n")],
      new Map(),
    );
    const greet = g.symbols.find((s) => s.name === "greet")!;
    expect(greet.fanIn).toBeGreaterThan(0);

    const mod = g.symbols.find((s) => s.kind === "module")!;
    expect(mod).toBeDefined();
    expect(mod.file).toBe("m.ts");
    expect(g.edges).toContainEqual({ source: mod.id, target: greet.id, kind: "calls" });
  });

  it("attributes a call inside an arrow held in a const to the arrow, not the module", async () => {
    // `export const helper = () => ...` is extracted with kind `function`, so it is already a
    // caller candidate. Asserted because it is easy to "fix" the kind filter into breaking it.
    const g = await buildSymbolGraph(
      [f("c.ts", "export function inner() { return 1; }\nexport const helper = () => inner();\n")],
      new Map(),
    );
    const inner = g.symbols.find((s) => s.name === "inner")!;
    const helper = g.symbols.find((s) => s.name === "helper")!;
    expect(g.edges).toContainEqual({ source: helper.id, target: inner.id, kind: "calls" });
  });

  it("attributes a class field-initialiser call to the class, not the module", async () => {
    // A field initialiser executes, so the class is the enclosing context. Without `class` in
    // the candidate kinds this silently becomes a module-scope edge - a wrong answer that
    // still looks like an answer.
    const g = await buildSymbolGraph(
      [f("k.ts", "export function seed() { return 1; }\nexport class Box {\n  value = seed();\n}\n")],
      new Map(),
    );
    const seed = g.symbols.find((s) => s.name === "seed")!;
    const box = g.symbols.find((s) => s.name === "Box")!;
    expect(g.edges).toContainEqual({ source: box.id, target: seed.id, kind: "calls" });
    expect(g.symbols.filter((s) => s.kind === "module")).toHaveLength(0);
  });

  it("does not report a module-scope-called function as dead code", async () => {
    // The user-visible bug: `rep` in pillars.test.ts is called four times in its own file and
    // was reported "Unreferenced function".
    const g = await buildSymbolGraph(
      [f("d.ts", "function used() { return 1; }\nconst out = [used(), used()];\nexport default out;\n")],
      new Map(),
    );
    const dead = new QueryEngine(g).deadCode().map((s) => s.name);
    expect(dead).not.toContain("used");
  });

  it("never reports the synthetic module node itself as dead code", async () => {
    // A module has no callers by construction. Emitting 107 of them into the dead-code list
    // would trade one false signal for another.
    const g = await buildSymbolGraph(
      [f("e.ts", "export function q() { return 1; }\nconst _ = q();\n")],
      new Map(),
    );
    expect(g.symbols.some((s) => s.kind === "module")).toBe(true);
    expect(new QueryEngine(g).deadCode().some((s) => s.kind === "module")).toBe(false);
  });

  it("creates no module node for a file that makes no module-scope call", async () => {
    // Lazy: otherwise every file gains a node, most of them inert.
    const g = await buildSymbolGraph(
      [f("p.ts", "export function a() { return 1; }\nexport function b() { return a(); }\n")],
      new Map(),
    );
    expect(g.symbols.filter((s) => s.kind === "module")).toHaveLength(0);
  });
});
