import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSwarm } from "@/lib/agents/orchestrator";
import { editorHref, findingLocation } from "@/lib/findings";
import type { Issue, RepoDetail } from "@/lib/types";

/**
 * What a finding SAYS, and where it goes.
 *
 * A browser walkthrough of the report found four defects that no type and no unit test
 * could see, because every one of them is a string or an href rather than a value:
 * `Dependency hygiene · 1 issues`, `5 issue(s)`, `4 finding(s); worst: …`, a panel titled
 * `Remediation Executor (M4)` naming an internal milestone at the user, and a `file:line`
 * that looked like a link and was not one. They are grouped here because they are one
 * failure — copy and navigation are not covered by the type checker, so they are only
 * defended if something asserts them on purpose.
 *
 * The behavioural half runs the real code paths. The scanning half is a ratchet: `(s)`
 * costs nothing to type and reappears the moment nobody is looking, which is how five of
 * them accumulated in the first place.
 */
const SRC = path.resolve(__dirname, "../src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sources(SRC).map((f) => [path.relative(SRC, f), readFileSync(f, "utf8")] as const);

function emptyGraph() {
  return { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } };
}

let n = 0;
function securityIssue(line: number): Issue {
  return {
    id: `i${n++}`,
    dimension: "security",
    severity: 5,
    confidence: 0.9,
    title: "Use of eval()",
    file: `a${line}.ts`,
    line,
    blastRadius: 1,
  };
}

function repoWithIssues(issues: Issue[]): RepoDetail {
  return {
    id: "r", url: "", name: "test", status: "done", sourceType: "git",
    score: 50, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null, drift: null,
    loc: 100, languages: [], graphStats: { nodes: 0, edges: 0, files: 0, dirs: 0, dependencies: 0 },
    dimensions: [], issues, dependencies: [], churnByFile: {},
    tree: { name: "/", path: ".", children: [] },
    viz: { nodes: [], edges: [] } as never,
    modules: { nodes: [], edges: [] },
    symbolGraph: emptyGraph(),
  };
}

function securitySummary(issues: Issue[]): string {
  const report = runSwarm(repoWithIssues(issues)).agents.find((a) => a.agent === "security");
  expect(report).toBeDefined();
  return report!.summary;
}

describe("specialist card summaries", () => {
  it("says `1 finding` for one, not `1 finding(s)`", () => {
    expect(securitySummary([securityIssue(10)])).toMatch(/^1 finding; worst: Use of eval\(\)\.$/);
  });

  it("says `4 findings` for four", () => {
    const summary = securitySummary([10, 20, 30, 40].map(securityIssue));
    expect(summary.startsWith("4 findings; worst: ")).toBe(true);
  });
});

describe("a finding's location", () => {
  it("names the line when the detector found one", () => {
    expect(findingLocation({ file: "src/index.js", line: 123 })).toBe("src/index.js:123");
  });

  /** Line 1 is the detectors' "whole file", so printing `:1` would claim a line it never found. */
  it("stays a bare path for a file-level finding", () => {
    expect(findingLocation({ file: "src/index.js", line: 1 })).toBe("src/index.js");
  });
});

describe("the editor deep link", () => {
  it("carries the file and the line the editor reads", () => {
    expect(editorHref("abc123", "src/index.js", 43)).toBe("/repos/abc123/editor?file=src%2Findex.js&line=43");
  });

  /** A path is not a query-string literal: `a+b.ts` unencoded arrives as `a b.ts`. */
  it("encodes a path that would otherwise change meaning in a query string", () => {
    expect(editorHref("r", "src/a+b?.ts", 2)).toBe("/repos/r/editor?file=src%2Fa%2Bb%3F.ts&line=2");
  });
});

describe("user-visible copy", () => {
  it("scans the sources it claims to, so the suite cannot pass by finding nothing", () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it.each(FILES.map(([name, src]) => [name, src]))(
    "%s pluralises findings and issues with the helper, never with a bare `(s)`",
    (_name, src) => {
      expect(src.match(/\b(?:issue|finding)\(s\)/gi) ?? []).toEqual([]);
    }
  );

  /**
   * `Remediation Executor (M4)` shipped a milestone number to people who have never seen
   * the plan it belongs to. A codename in a heading is not a version, it is a leak.
   */
  it.each(FILES.map(([name, src]) => [name, src]))("%s names no internal milestone", (_name, src) => {
    expect(src.match(/\(M[1-9]\)/g) ?? []).toEqual([]);
  });

  it("counts a score dimension's findings through `plural`, so `1 issues` cannot come back", () => {
    const [, report] = FILES.find(([name]) => name === path.join("app", "repos", "[id]", "page.tsx"))!;
    const uses = report.match(/d\.issueCount/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(report.match(/plural\(d\.issueCount, "issue"\)/g) ?? []).toHaveLength(uses.length);
  });
});
