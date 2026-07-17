import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "@/lib/codeintel/graph";

describe("graph resolution accuracy (Tasks 6.1/6.2)", () => {
  it("attributes calls to enclosing function by line, and resolves imports accurately", async () => {
    const graph = await buildSymbolGraph([
      {
        rel: "utils/parse.ts", ext: ".ts", language: "TypeScript",
        text: `export function parse() { return 1; }`
      },
      {
        rel: "other/parse.ts", ext: ".ts", language: "TypeScript",
        text: `export function parse() { return 2; }`
      },
      {
        rel: "main.ts", ext: ".ts", language: "TypeScript",
        text: `
          import { parse } from "./utils/parse";
          
          export function wrapper() {
             // Shouldn't get the call since it's just a top-level func
          }
          
          export function outer() {
             // outer shouldn't get the call, only inner
             function inner() {
                parse(); // Line 8
             }
          }
        `.trim()
      }
    ], new Map());

    // 1. Check Import Resolution
    const calls = graph.edges.filter(e => e.kind === "calls");
    const parseEdge = calls.find(e => e.target.startsWith("utils/parse.ts"));
    expect(parseEdge).toBeDefined(); // It picked the imported one!
    const wrongEdge = calls.find(e => e.target.startsWith("other/parse.ts"));
    expect(wrongEdge).toBeUndefined(); // It ignored the global name-collide!

    // 2. Check Caller Attribution
    const callerId = parseEdge!.source;
    expect(callerId).toContain("#inner@9"); // Enclosing function gets the call!
    expect(callerId).not.toContain("wrapper"); // Top-level first-func didn't steal it
    expect(callerId).not.toContain("outer"); // Enclosing beats outer
  });
});
