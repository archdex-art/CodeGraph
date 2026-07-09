import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

// A Python compound-statement header requires a non-empty indented suite.
// This mirrors (independently) the fixer's own opener detection so the test
// can verify structural validity of the *output* without importing internals.
const BLOCK_OPENER_RE = /^\s*(if|elif|else|for|while|try|except|finally|with|def|class)\b.*:\s*$/;

// Asserts that no block-opener line in `lines` is immediately followed (skipping
// blanks) by a same-or-lower-indented line, i.e. every `...:` header still has a
// non-empty, more-indented suite.
function assertNoEmptyPythonBlocks(lines: string[]) {
  for (let i = 0; i < lines.length; i++) {
    if (!BLOCK_OPENER_RE.test(lines[i])) continue;
    const openIndent = /^ */.exec(lines[i])![0].length;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    expect(j).toBeLessThan(lines.length);
    expect(/^ */.exec(lines[j])![0].length).toBeGreaterThan(openIndent);
  }
}

describe("fixers: python block-body protection", () => {
  it("never empties a block whose entire body is debug prints (nested if/else/for repro)", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = [
      "    if not spans:",
      '        print("a")',
      "    else:",
      "        for i, s in enumerate(spans, 1):",
      "            print(i)",
    ];
    const out = fx.apply({ rel: "a.py", ext: ".py", lines });

    // Both sole-statement blocks must have been rescued.
    expect(out.lines.some((l) => l.trim() === 'print("a")')).toBe(true);
    expect(out.lines.some((l) => l.trim() === "print(i)")).toBe(true);

    // Structural check: no `...:` header is left with an empty/under-indented suite.
    assertNoEmptyPythonBlocks(out.lines);

    let hasPython = true;
    try {
      execSync("python3 --version", { stdio: "ignore" });
    } catch {
      hasPython = false;
    }

    if (hasPython) {
      const dir = mkdtempSync(path.join(tmpdir(), "fixer-test-"));
      const file = path.join(dir, "repro.py");
      try {
        // `out.lines` retain the original 4-space indent (they were excerpted from
        // inside a function), so wrap in an enclosing `def` to make the file a
        // valid standalone module for py_compile.
        writeFileSync(file, `def _wrapper():\n${out.lines.join("\n")}\n`, "utf8");
        expect(() => execSync(`python3 -m py_compile ${JSON.stringify(file)}`, { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rescues at least one statement when a block's body is multiple consecutive debug prints", () => {
    // Regression guard for a naive "is my immediate predecessor a block opener"
    // check, which would wrongly delete both lines since neither individually
    // looks like the sole survivor from a purely local view.
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if x:", '    print("a")', '    print("b")'];
    const out = fx.apply({ rel: "a.py", ext: ".py", lines });

    expect(out.lines.some((l) => l.trim() === 'print("a")' || l.trim() === 'print("b")')).toBe(true);
    assertNoEmptyPythonBlocks(out.lines);
  });

  it("still removes a debug print when the block also has a real statement", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if y:", "    x = 1", '    print("debug")'];
    const out = fx.apply({ rel: "a.py", ext: ".py", lines });

    expect(out.edits.length).toBe(1);
    expect(out.lines.some((l) => l.trim() === 'print("debug")')).toBe(false);
    expect(out.lines).toContain("    x = 1");
  });

  it("leaves JS/TS blocks alone (empty {} is valid, no protection needed)", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (x) {", '  console.log("debug");', "}"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });

    expect(out.edits.length).toBe(1);
    expect(out.lines.some((l) => l.trim() === 'console.log("debug");')).toBe(false);
  });
});
