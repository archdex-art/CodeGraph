import { describe, expect, it } from "vitest";
import { structuralMetrics } from "../src/structure";

/**
 * A rough proxy, tested for the properties it actually claims: that it ORDERS files sensibly.
 * Exact counts from a regex scan are not meaningful and are not asserted.
 */

describe("cyclomatic proxy", () => {
  it("is 1 for straight-line code", () => {
    expect(structuralMetrics("const a = 1;\nconst b = 2;\n", false).cyclomatic).toBe(1);
  });

  it("rises with branches", () => {
    const flat = structuralMetrics("const a = 1;\n", false).cyclomatic;
    const branchy = structuralMetrics(
      "if (a) {} else if (b) {}\nfor (;;) {}\nwhile (x) {}\n",
      false,
    ).cyclomatic;
    expect(branchy).toBeGreaterThan(flat + 3);
  });

  it("does not count branch words inside strings or comments", () => {
    // The reason `stripNoise` exists: prose about control flow is not control flow.
    const prose = structuralMetrics(
      'const msg = "use if and for and while";\n// if for while case\n/* if for */\n',
      false,
    );
    expect(prose.cyclomatic).toBe(1);
  });

  it("counts Python branch keywords", () => {
    const py = structuralMetrics("if a:\n    pass\nelif b:\n    pass\nfor x in y:\n    pass\n", true);
    expect(py.cyclomatic).toBeGreaterThan(3);
  });
});

describe("nesting", () => {
  it("uses braces for C-family", () => {
    expect(structuralMetrics("function f(){ if(a){ if(b){ x(); } } }", false).maxNesting).toBe(3);
  });

  it("uses indentation for Python, where braces would give zero", () => {
    const src = "def f():\n    if a:\n        if b:\n            return 1\n";
    expect(structuralMetrics(src, true).maxNesting).toBe(3);
    // The same file scanned as C-family finds no braces at all — hence the branch.
    expect(structuralMetrics(src, false).maxNesting).toBe(0);
  });

  it("does not go negative on unbalanced braces", () => {
    expect(structuralMetrics("} } } }", false).maxNesting).toBe(0);
  });
});

describe("comment ratio", () => {
  it("is 0 for uncommented code and rises with comments", () => {
    expect(structuralMetrics("const a = 1;\n", false).commentRatio).toBe(0);
    expect(structuralMetrics("// a\n// b\nconst a = 1;\n", false).commentRatio).toBeGreaterThan(0.4);
  });

  it("recognises Python comments", () => {
    expect(structuralMetrics("# note\nx = 1\n", true).commentRatio).toBeGreaterThan(0.3);
  });
});

describe("longest block", () => {
  it("measures the longest run of non-blank lines", () => {
    expect(structuralMetrics("a\nb\nc\n\nd\n", false).longestBlock).toBe(3);
  });

  it("is 0 for an empty file", () => {
    expect(structuralMetrics("", false).longestBlock).toBe(0);
  });
});

describe("degenerate input", () => {
  it("returns finite numbers for empty text", () => {
    const m = structuralMetrics("", false);
    expect(Object.values(m).every(Number.isFinite)).toBe(true);
  });
});
