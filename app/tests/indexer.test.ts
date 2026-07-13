import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexRepo } from "@/lib/indexer";
import type { IndexResult, Issue, CodeSymbol } from "@/lib/types";

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
    const langs = result.languages.map((l: any) => l.language);
    expect(langs).toContain("TypeScript");
  });

  it("flags the eval() usage as an issue", () => {
    const evalIssue = result.issues.find((i: Issue) => /eval/i.test(i.title));
    expect(evalIssue).toBeDefined();
    expect(evalIssue!.dimension).toBe("security");
  });

  it("extracts foo and bar into the symbol graph", () => {
    const names = result.symbolGraph.symbols.map((s: CodeSymbol) => s.name);
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

// Regression coverage for the hardcoded-secret rule's `validate` filter:
// placeholder/example values (a literal "..." ellipsis, or a common
// placeholder word like "your_api_key_here"/"changeme") must not be
// reported as live secrets, even though they match the rule's regex.
// Each case lives in its own file because `analyzeFiles` stops scanning a
// given rule after its first (accepted) match per file — spreading the
// cases across files is what lets this test tell "found nothing" apart
// from "found the wrong line".
describe("secret detection precision", () => {
  let dir: string;
  let result: IndexResult;

  const REAL_SECRET_FILE = "auth.py";
  const REAL_SECRET_LINE = 5;
  const ELLIPSIS_FILE = "docs_example.py";
  const ELLIPSIS_LINE = 4;
  const WORD_PLACEHOLDER_FILE = "settings_template.py";
  const WORD_PLACEHOLDER_LINE = 2;
  const CHANGEME_FILE = "env_example.py";
  const CHANGEME_LINE = 2;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cg-secret-idx-"));

    // A genuine-looking hardcoded secret - the one finding this fixture
    // expects. No ellipsis, no placeholder word, realistic-looking value.
    writeFileSync(
      path.join(dir, REAL_SECRET_FILE),
      [
        "import os",
        "",
        "",
        "def get_client():",
        '    api_key = "sk_live_9f8a7b6c5d4e"',
        "    return Client(api_key)",
        "",
      ].join("\n")
    );

    // A Python docstring usage example whose value is a literal "..."
    // ellipsis - the exact real-world false-positive class the fix covers.
    writeFileSync(
      path.join(dir, ELLIPSIS_FILE),
      [
        '"""',
        "Example usage:",
        "",
        '    client = Client(api_key="am_live_...")',
        '"""',
        "",
      ].join("\n")
    );

    // A settings template using a common placeholder word.
    writeFileSync(
      path.join(dir, WORD_PLACEHOLDER_FILE),
      [
        "# Copy this file to settings.py and fill in real credentials before running.",
        'api_key = "your_api_key_here"',
        "",
      ].join("\n")
    );

    // A sample env file using the "changeme" convention.
    writeFileSync(
      path.join(dir, CHANGEME_FILE),
      [
        "# Sample environment configuration - replace before deploying",
        'token = "changeme"',
        "",
      ].join("\n")
    );

    result = indexRepo(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags only the genuine hardcoded secret, not placeholder/example values", () => {
    const secretIssues = result.issues.filter(
      (i: Issue) => i.title === "Possible hardcoded secret"
    );
    expect(secretIssues).toHaveLength(1);

    const [finding] = secretIssues;
    expect(finding.file).toBe(REAL_SECRET_FILE);
    expect(finding.line).toBe(REAL_SECRET_LINE);

    // Explicit guard against the false-positive class this fix targets:
    // the finding must not point at any of the placeholder/example lines.
    expect(finding.line).not.toBe(ELLIPSIS_LINE);
    expect(finding.line).not.toBe(WORD_PLACEHOLDER_LINE);
    expect(finding.line).not.toBe(CHANGEME_LINE);
  });
});
