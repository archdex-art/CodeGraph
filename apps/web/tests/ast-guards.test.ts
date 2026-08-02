import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FIXERS } from "@codegraph/remediate-engine";
import { deletableDebugLines } from "@codegraph/remediate-engine";

/**
 * Review B1's structural cure: the debug fixer decides from the AST, not from a line scan.
 *
 * The shipped guard walked backward to the previous non-blank line and tested whether it
 * *looked like* a brace-less block opener. Two failures were reproduced against it, and the
 * first is the one that matters most because nothing downstream could catch it:
 *
 *   const helpText = `
 *     Usage: run --verbose
 *     console.log("hello");
 *   `;
 *
 * It deleted the third line — string CONTENT — silently rewriting a user-visible help message
 * while reporting "no production behavior". The file still parses, so verification gate 1's
 * bracket-balance check passes too. Valid file, wrong data.
 */

const fx = FIXERS.find((f) => f.id === "remove-debug-output")!;

function run(src: string, ext = ".ts") {
  const res = fx.apply({ rel: `t${ext}`, ext, lines: src.split("\n") });
  const after = res.lines.join("\n");
  const sf = ts.createSourceFile("t.ts", after, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseFailed =
    ((sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length > 0;
  return { edits: res.edits.length, after, parseFailed };
}

describe("debug fixer — must not touch these", () => {
  it("leaves a console.log inside a template literal alone", () => {
    // The bug. Asserted on CONTENT, not just edit count, because the point is the string's
    // value survives.
    const src = 'const h = `\n  Usage: x\n  console.log("hello");\n`;\nexport const y = h;';
    const { edits, after } = run(src);
    expect(edits).toBe(0);
    expect(after).toContain('console.log("hello")');
  });

  it("leaves the body of a labelled statement alone", () => {
    // Removing it moves the label onto the following statement.
    expect(run('outer:\n  console.log("x");\nnext();').edits).toBe(0);
  });

  it.each([
    ["brace-less if", 'if (a)\n  console.log("x");\nnext();'],
    ["multi-line condition", 'if (\n  a &&\n  b\n)\n  console.log("x");\nnext();'],
    ["brace-less else", 'if (a) { y(); } else\n  console.log("x");\nnext();'],
    ["brace-less for-of", 'for (const a of b)\n  console.log(a);\nnext();'],
    ["brace-less while", 'while (a)\n  console.log(a);\nnext();'],
    ["brace-less do-while", 'do\n  console.log("x");\nwhile (a);'],
    ["arrow expression body", 'const f = () =>\n  console.log("x");\nexport { f };'],
  ])("leaves the sole body of %s alone", (_name, src) => {
    const { edits, parseFailed } = run(src);
    expect(edits).toBe(0);
    expect(parseFailed).toBe(false);
  });

  it("leaves a commented-out call alone", () => {
    expect(run('// console.log("x");\nnext();').edits).toBe(0);
  });

  it("leaves a console.log nested in a larger expression alone", () => {
    // Deleting the line would delete the surrounding expression with it.
    expect(run("const v = [1].map((n) => console.log(n));\nexport { v };").edits).toBe(0);
  });
});

describe("debug fixer — must still fix these", () => {
  it.each([
    ["a statement inside a function block", 'function f() {\n  console.log("x");\n  return 1;\n}\nexport { f };'],
    ["a top-level statement", 'console.log("x");\nexport const y = 1;'],
    ["a statement inside a braced if", 'if (a) {\n  console.log("x");\n  y();\n}\nexport {};'],
    ["a debugger statement", "function f() {\n  debugger;\n  return 1;\n}\nexport { f };"],
    ["a statement in a switch case", 'switch (a) {\n  case 1:\n    console.log("x");\n    break;\n}\nexport {};'],
  ])("removes %s", (_name, src) => {
    const { edits, parseFailed } = run(src);
    expect(edits).toBe(1);
    expect(parseFailed).toBe(false);
  });
});

describe("deletableDebugLines", () => {
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

  it("reports 0-based line indexes", () => {
    const { deletable } = deletableDebugLines('const a = 1;\nconsole.log("x");\n', "t.ts");
    expect([...deletable]).toEqual([1]);
  });
});

describe("python is unaffected", () => {
  it("still removes a standalone print via the indentation-aware path", () => {
    // No Python parser in this process, so Python keeps the line-based guard — which is the
    // right tool where indentation IS the block structure.
    const res = fx.apply({
      rel: "t.py",
      ext: ".py",
      lines: ["def f():", "    x = 1", "    print('debug')", "    return x"],
    });
    expect(res.edits).toHaveLength(1);
  });

  it("still protects a print that is a block's only statement", () => {
    const res = fx.apply({
      rel: "t.py",
      ext: ".py",
      lines: ["def f():", "    print('only')"],
    });
    expect(res.edits).toHaveLength(0);
  });
});
