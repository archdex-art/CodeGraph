import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXERS, fixerById } from "@codegraph/remediate-engine";
import { executeFixes } from "@/lib/agents/executor";
import type { RepoDetail } from "@/lib/types";

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
        score: 0, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null, drift: null,
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
      // The surviving fixer surface, exercised end to end. It is deliberately ONE fixer:
      // `remove-debug-output` and `remove-todo-marker` were withdrawn after a real run
      // deleted `print(f"check_boundaries: OK …")` — a script's intended output — and
      // proposed thirteen TODO-comment deletions no reviewer would accept.
      const fixerIds = new Set(result.edits.map((e) => e.fixer));
      expect(fixerIds).toEqual(new Set(["annotate-empty-catch"]));
      expect(result.scoreAfter).toBeGreaterThanOrEqual(result.scoreBefore);
      expect(result.issuesAfter).toBeLessThan(result.issuesBefore);

      // Diff correctness: deletions show only a `-` line; the replacement (empty
      // catch) shows a `-`/`+` pair with the new content, not a bare deletion.
      expect(result.pr).not.toBeNull();
      const diff = result.pr!.diff;
      // A replacement shows a `-`/`+` pair carrying the new content, not a bare deletion.
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
