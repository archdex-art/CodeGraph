import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extractorFor } from "../src/index";

// The registered `.ts` extractor is `astTsExtractor(tsExtractor)` — the AST
// extractor with the regex one as its fallback. Going through `extractorFor`
// rather than constructing it here means these tests exercise the exact
// composition production uses, and `tsExtractor` stays package-internal.
function extract(ctx: { text: string; relPath: string; program?: ts.Program }) {
  const extractor = extractorFor(".ts");
  if (!extractor) throw new Error("no .ts extractor registered");
  return extractor.extract(ctx);
}

/**
 * The AST extractor's program-shaped inputs.
 *
 * These exist because the LLD §13.2 move typed `ExtractContext.program` as
 * `ts.Program` instead of `any`, and the compiler immediately reported three
 * unchecked-`undefined` sites that the `any` had been hiding. This suite pins the
 * behaviour at each of them so the guard cannot be quietly removed later.
 */

const SOURCE = `
export function alpha(x: number): number {
  return x + 1;
}
export class Beta {
  gamma(): void {}
}
`;

describe("ts extractor without a program", () => {
  it("extracts symbols from a standalone parse", () => {
    const result = extract({ text: SOURCE, relPath: "a.ts" });
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("Beta");
  });

  it("reports 1-indexed lines", () => {
    // SOURCE starts with a newline, so `alpha` is on line 2. Off-by-one here would
    // misattribute every finding by a line.
    const result = extract({ text: SOURCE, relPath: "a.ts" });
    expect(result.symbols.find((s) => s.name === "alpha")?.line).toBe(2);
  });
});

describe("ts extractor with a program that does not contain the file", () => {
  /**
   * The case the `any` hid. A `ts.Program` is built from a tsconfig's file list,
   * so a path that does not normalise identically — or a file outside the
   * program's roots — is simply absent, and `getSourceFile` returns undefined.
   *
   * The pre-guard behaviour was measured, not assumed, and it was NOT a crash:
   * `ts.forEachChild(undefined, …)` visits nothing and throws nothing, so the
   * extractor returned an empty result and reported success. Silence is the worse
   * of the two failures — the file contributes no symbols and no edges to the
   * graph, and nothing reports it.
   *
   * So these tests assert on the CONTENT of the result. An earlier draft asserted
   * only `.not.toThrow()`, which passed against the broken version too and
   * therefore defended nothing.
   */
  const emptyProgram = ts.createProgram({ rootNames: [], options: {} });

  it("still finds the file's symbols instead of silently returning none", () => {
    const result = extract({ text: SOURCE, relPath: "absent.ts", program: emptyProgram });
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.symbols.map((s) => s.name)).toContain("alpha");
  });

  it("still extracts the same symbols via the standalone fallback", () => {
    // Degrading to a standalone parse is not a new code path — it is the one
    // already taken when no program is supplied. Only type-aware call resolution
    // is lost, and that was never available for a file the program does not know.
    const withProgram = extract({
      text: SOURCE,
      relPath: "absent.ts",
      program: emptyProgram,
    });
    const without = extract({ text: SOURCE, relPath: "absent.ts" });

    expect(withProgram.symbols.map((s) => s.name)).toEqual(without.symbols.map((s) => s.name));
  });

  it("emits no resolved reference targets, rather than wrong ones", () => {
    // The checker is dropped when it cannot answer questions about this file.
    // Keeping it would invite resolution against an unrelated source file.
    const result = extract({
      text: SOURCE,
      relPath: "absent.ts",
      program: emptyProgram,
    });
    expect(result.references.every((r) => r.resolvedTargetId === undefined)).toBe(true);
  });
});
