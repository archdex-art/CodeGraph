import { describe, it, expect } from "vitest";
import { FIXERS, fixerById } from "@/lib/agents/fixers";

describe("fixers", () => {
  it("registry resolves the debug fixer", () => {
    expect(FIXERS.length).toBeGreaterThan(0);
    expect(fixerById("remove-debug-output")).not.toBeNull();
    expect(fixerById("nope")).toBeNull();
  });

  it("removes standalone console.log / debugger lines and records edits", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = [
      "function foo() {",
      "  console.log('debug');",
      "  const x = 1;",
      "  debugger;",
      "  return x;",
      "}",
    ];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits.length).toBe(2);
    expect(out.lines).not.toContain("  console.log('debug');");
    expect(out.lines).not.toContain("  debugger;");
    expect(out.lines).toContain("  const x = 1;");
    expect(out.lines).toContain("  return x;");
    // provenance: removed lines recorded with after=null
    expect(out.edits.every((e) => e.after === null)).toBe(true);
  });

  it("does NOT remove console.log embedded in a larger expression", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["const y = (console.log('x'), 5);"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits.length).toBe(0);
    expect(out.lines).toEqual(lines);
  });

  it("removes standalone python print() only for .py", () => {
    const fx = fixerById("remove-debug-output")!;
    const py = fx.apply({ rel: "a.py", ext: ".py", lines: ["print('hi')", "x = 1"] });
    expect(py.edits.length).toBe(1);
    const ts = fx.apply({ rel: "a.ts", ext: ".ts", lines: ["print('hi')", "x = 1"] });
    expect(ts.edits.length).toBe(0);
  });
});
