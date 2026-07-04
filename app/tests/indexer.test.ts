import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexRepo } from "@/lib/indexer";
import type { IndexResult } from "@/lib/indexer";

// Builds a tiny real repo on disk, runs the real synchronous indexer once,
// and asserts on the full result shape (no network, no git).
describe("indexRepo", () => {
  let dir: string;
  let result: IndexResult;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cg-idx-"));
    writeFileSync(
      path.join(dir, "a.ts"),
      [
        "import { bar } from './b';",
        "export function foo() {",
        "  eval('x');",
        "  return bar();",
        "}",
        "",
      ].join("\n")
    );
    writeFileSync(
      path.join(dir, "b.ts"),
      ["export function bar() {", "  return 1;", "}", ""].join("\n")
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2)
    );
    result = indexRepo(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an overall score in the 0..100 range", () => {
    expect(typeof result.score).toBe("number");
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("detects TypeScript as a language", () => {
    const langs = result.languages.map((l) => l.language);
    expect(langs).toContain("TypeScript");
  });

  it("flags the eval() usage as an issue", () => {
    const evalIssue = result.issues.find((i) => /eval/i.test(i.title));
    expect(evalIssue).toBeDefined();
    expect(evalIssue!.dimension).toBe("security");
  });

  it("extracts foo and bar into the symbol graph", () => {
    const names = result.symbolGraph.symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("bar");
    expect(result.symbolGraph.stats.symbols).toBeGreaterThanOrEqual(2);
  });

  it("builds a non-empty file tree and module graph", () => {
    expect(result.tree.children).toBeDefined();
    expect(result.tree.children!.length).toBeGreaterThan(0);
    expect(result.modules.nodes.length).toBeGreaterThanOrEqual(1);
  });
});
