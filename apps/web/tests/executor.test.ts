import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXERS, fixerById } from "@codegraph/remediate-engine";
import { executeFixes } from "@/lib/agents/executor";
import type { RepoDetail } from "@/lib/types";

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

  // --- Brace-less JS block bodies -------------------------------------------
  // The file still PARSES after a bad deletion here, so no syntax check catches
  // it — the program just silently does something else. These are the cases
  // that made the fixer unsafe to point at a real repository.

  it("refuses to delete the sole body of a brace-less `if` (would promote the next statement)", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (!authorized)", '  console.log("denied");', "grantAccess();"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });

    expect(out.edits).toHaveLength(0);
    expect(out.lines).toEqual(lines); // byte-identical: nothing touched
  });

  it("refuses to delete a brace-less `else` body", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (a) {", "  b();", "} else", '  console.log("fallback");', "after();"];
    const out = fx.apply({ rel: "a.js", ext: ".js", lines });

    expect(out.edits).toHaveLength(0);
    expect(out.lines).toEqual(lines);
  });

  it.each([
    ["for", ["for (const x of xs)", "  console.log(x);", "total++;"]],
    ["while", ["while (running)", "  console.log(tick);", "cleanup();"]],
    ["arrow body", ["arr.forEach((x) =>", "  console.log(x)", ");"]],
  ])("refuses to delete a brace-less %s body", (_label, lines) => {
    const fx = fixerById("remove-debug-output")!;
    const out = fx.apply({ rel: "a.js", ext: ".js", lines: lines as string[] });
    expect(out.edits).toHaveLength(0);
  });

  it("recognises a brace-less opener that carries a trailing line comment", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (x) // guard", '  console.log("hit");', "next();"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits).toHaveLength(0);
  });

  it("still deletes a debug line that plainly follows a completed statement", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["const x = compute();", '  console.log("x", x);', "return x;"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });

    expect(out.edits).toHaveLength(1);
    expect(out.lines).toEqual(["const x = compute();", "return x;"]);
  });

  it("deletes a run of consecutive debug lines — they must not protect each other", () => {
    const fx = fixerById("remove-debug-output")!;
    // Semicolon-less style: each line ends in `)`, so a naive lookback would
    // treat every line after the first as a possible brace-less body.
    const lines = ["const a = 1", "console.log(a)", "console.log(a * 2)", "return a"];
    const out = fx.apply({ rel: "a.js", ext: ".js", lines });

    expect(out.edits).toHaveLength(2);
    expect(out.lines).toEqual(["const a = 1", "return a"]);
  });

  it("protects only the block body, still deleting an unrelated debug line below it", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (x)", '  console.log("body");', 'console.log("standalone");'];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });

    expect(out.edits).toHaveLength(1);
    expect(out.edits[0].line).toBe(3);
    expect(out.lines).toEqual(["if (x)", '  console.log("body");']);
  });

  it("refuses to delete a brace-less body guarded by a multi-line condition", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (a &&", "    b)", '  console.log("both");', "proceed();"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits).toHaveLength(0);
  });

  it("applies the same protection to a bare `debugger` statement", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ["if (x)", "  debugger;", "proceed();"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits).toHaveLength(0);
  });

  it("deletes a debug line at the very start of a file", () => {
    const fx = fixerById("remove-debug-output")!;
    const lines = ['console.log("boot");', "start();"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits).toHaveLength(1);
    expect(out.lines).toEqual(["start();"]);
  });
});

describe("fixers: TODO/FIXME marker removal", () => {
  it("removes standalone TODO/FIXME/HACK/XXX comment lines only", () => {
    const fx = fixerById("remove-todo-marker")!;
    const lines = [
      "// TODO: refactor this",
      "const x = 1;",
      "# FIXME later",
      '  const s = "TODO.md has notes"; // not a comment-only line, must survive',
    ];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits.length).toBe(2);
    expect(out.lines).not.toContain("// TODO: refactor this");
    expect(out.lines).not.toContain("# FIXME later");
    expect(out.lines).toContain("const x = 1;");
    // A TODO mention inside a real code line's string literal is never touched.
    expect(out.lines.some((l) => l.includes('"TODO.md has notes"'))).toBe(true);
  });
});

describe("fixers: empty catch block annotation", () => {
  it("documents an empty catch without deleting it, and stops matching the smell regex", () => {
    const fx = fixerById("annotate-empty-catch")!;
    const lines = ["try {", "  risky();", "} catch (e) {}", "done();"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    expect(out.edits.length).toBe(1);
    expect(out.edits[0].after).not.toBeNull();
    expect(out.lines).toHaveLength(lines.length); // no line removed, only content replaced
    expect(out.lines[2]).toContain("intentionally ignored");
    // The exact regex indexer.ts uses to flag this smell must no longer match.
    expect(/catch\s*\([^)]*\)\s*\{\s*\}/.test(out.lines[2])).toBe(false);
  });

  it("does not touch Python files (no curly-brace catch there)", () => {
    const fx = fixerById("annotate-empty-catch")!;
    const out = fx.apply({ rel: "a.py", ext: ".py", lines: ["except Exception:", "    pass"] });
    expect(out.edits.length).toBe(0);
  });

  it("preserves the original indentation of the annotated catch line (regression: after was trimmed)", () => {
    const fx = fixerById("annotate-empty-catch")!;
    const lines = ["    try {", "      risky();", "    } catch (e) {}"];
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines });
    // The replacement MUST keep the leading 4-space indent, not collapse to col 0.
    expect(out.lines[2]).toBe("    } catch (e) { /* intentionally ignored */ }");
    // The recorded edit's `after` is the authoritative content the executor
    // writes to disk and emits in the diff — it must equal the full new line.
    expect(out.edits[0].after).toBe("    } catch (e) { /* intentionally ignored */ }");
  });

  it("does not truncate a long catch line when annotating (regression: after was sliced to 120 chars)", () => {
    const fx = fixerById("annotate-empty-catch")!;
    const tail = "x".repeat(140);
    const line = `} catch (e) {} // ${tail}`;
    const out = fx.apply({ rel: "a.ts", ext: ".ts", lines: [line] });
    // The full line (well over 120 chars) must survive intact after the edit.
    expect(out.lines[0]).toBe(`} catch (e) { /* intentionally ignored */ } // ${tail}`);
    expect(out.edits[0].after).toBe(out.lines[0]);
  });
});

describe("executeFixes: end-to-end sandboxed remediation", () => {
  it("fixes multiple independent issue classes in one pass and produces a correct diff", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "executor-e2e-"));
    try {
      writeFileSync(
        path.join(dir, "app.ts"),
        [
          "export function run(x: number) {",
          "  console.log('debug trace');",
          "  // TODO: handle the zero case",
          "  try {",
          "    return 10 / x;",
          "  } catch (e) {}",
          "}",
        ].join("\n"),
        "utf8"
      );
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "e2e-fixture", version: "1.0.0" }), "utf8");

      const repo: RepoDetail = {
        id: "e2e", url: dir, name: "e2e-fixture", status: "done", sourceType: "local",
        score: 0, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null,
        loc: 0, languages: [], graphStats: { nodes: 0, edges: 0, files: 0, dirs: 0, dependencies: 0 },
        dimensions: [], issues: [], dependencies: [], churnByFile: {},
        tree: { name: "/", path: ".", children: [] },
        viz: { nodes: [], edges: [] } as any,
        modules: { nodes: [], edges: [] },
        symbolGraph: { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } },
      };

      const result = await executeFixes(repo);
      expect(result.ok).toBe(true);
      expect(result.verified).toBe(true);
      // All 3 fixer classes fired in one pass: debug output, TODO marker, empty catch.
      const fixerIds = new Set(result.edits.map((e) => e.fixer));
      expect(fixerIds).toEqual(new Set(["remove-debug-output", "remove-todo-marker", "annotate-empty-catch"]));
      expect(result.scoreAfter).toBeGreaterThanOrEqual(result.scoreBefore);
      expect(result.issuesAfter).toBeLessThan(result.issuesBefore);

      // Diff correctness: deletions show only a `-` line; the replacement (empty
      // catch) shows a `-`/`+` pair with the new content, not a bare deletion.
      expect(result.pr).not.toBeNull();
      const diff = result.pr!.diff;
      expect(diff).toContain("-  console.log('debug trace');");
      expect(diff).not.toContain("+  console.log");
      expect(diff).toContain("-  } catch (e) {}");
      expect(diff).toContain("intentionally ignored");
      // The `+` replacement must carry the fixture's original 2-space indent —
      // regression guard for the trimmed/truncated `after` bug.
      expect(diff).toContain("+  } catch (e) { /* intentionally ignored */ }");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
