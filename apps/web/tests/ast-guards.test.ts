import { describe, expect, it } from "vitest";
import { deletableDebugLines } from "@codegraph/remediate-engine";

/**
 * Review B1's structural cure, tested directly on the guard.
 *
 * WHY THIS FILE NO LONGER GOES THROUGH A FIXER. `remove-debug-output` was deleted: its safety
 * argument was "a standalone `print()`/`console.log` has no production behaviour", and a real
 * run deleted `print(f"check_boundaries: OK — …")` from `scripts/check_boundaries.py`, which is
 * that script's entire output. No AST guard can recover intent, so the codemod went and the
 * guard stayed — it answers a narrower, and true, question: "is this line a standalone
 * statement, or is it text inside a string, a comment, or the sole body of a construct that
 * needs one?"
 *
 * That question is what the shipped line-scan got wrong. Given
 *
 *   const helpText = `
 *     Usage: run --verbose
 *     console.log("hello");
 *   `;
 *
 * it reported the third line — string CONTENT — as deletable, and the file still parses
 * afterwards, so verification gate 1 could not catch it either. Valid file, wrong data. The
 * cases below pin the guard's answers so the next codemod that needs them inherits the fix
 * rather than the bug.
 */

const linesOf = (src: string) => [...deletableDebugLines(src, "t.ts").deletable];

describe("deletableDebugLines — never deletable", () => {
  it("refuses everything when the file does not parse", () => {
    // A file whose structure is unknown is a file no fixer should edit. Falling back to a
    // regex here is exactly what produced B1.
    const { deletable, parseFailed } = deletableDebugLines(
      'function f() {\n  console.log("x");\n', // unclosed brace
      "t.ts"
    );
    expect(parseFailed).toBe(true);
    expect(deletable.size).toBe(0);
  });

  it("does not report a console.log inside a template literal", () => {
    // The failure nothing downstream could catch: the line is string content, not a statement.
    expect(linesOf('const help = `\n  Usage: run\n  console.log("hello");\n`;\n')).toEqual([]);
  });

  it("does not report the body of a labelled statement", () => {
    expect(linesOf('outer:\n  console.log("x");\nnext();\n')).toEqual([]);
  });

  it.each([
    ["a brace-less if", 'if (!authorized)\n  console.log("denied");\ngrantAccess();\n'],
    ["a brace-less else", 'if (a) {\n  b();\n} else\n  console.log("f");\nafter();\n'],
    ["a brace-less for", 'for (const x of xs)\n  console.log(x);\nafter();\n'],
    ["a brace-less while", 'while (go)\n  console.log("tick");\nafter();\n'],
    ["an arrow body", 'xs.forEach((x) =>\n  console.log(x)\n);\n'],
  ])("does not report the sole body of %s", (_name, src) => {
    // Deleting these either promotes the NEXT statement into the block — the file still
    // parses and the program does the opposite of what it did — or breaks the parse outright.
    expect(linesOf(src)).toEqual([]);
  });

  it("does not report a commented-out call", () => {
    expect(linesOf('// console.log("x");\nnext();\n')).toEqual([]);
  });

  it("does not report a console.log nested in a larger expression", () => {
    expect(linesOf("const y = (console.log('x'), 5);\n")).toEqual([]);
  });
});

describe("deletableDebugLines — deletable, with 0-based indexes", () => {
  it("reports 0-based line indexes", () => {
    expect(linesOf('const a = 1;\nconsole.log("x");\n')).toEqual([1]);
  });

  it.each([
    ["a statement inside a function block", 'function f() {\n  console.log("x");\n  return 1;\n}\n', 1],
    ["a statement inside a braced if", 'if (a) {\n  console.log("x");\n  y();\n}\n', 1],
    ["a debugger statement", "function f() {\n  debugger;\n  return 1;\n}\n", 1],
    ["a statement in a switch case", 'switch (a) {\n  case 1:\n    console.log("x");\n    break;\n}\n', 2],
  ])("reports %s", (_name, src, line) => {
    expect(linesOf(src as string)).toEqual([line]);
  });
});
