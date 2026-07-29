import { describe, it, expect } from "vitest";
import { SPECIALISTS, resetSeq, type AgentContext } from "@/lib/agents/specialists";
import { buildSymbolGraph } from "@/lib/codeintel/graph";
import { QueryEngine } from "@/lib/codeintel/query";
import type { RepoDetail, Issue } from "@/lib/types";
import type { FileInput } from "@/lib/codeintel/graph";

function specialist(id: string) {
  const s = SPECIALISTS.find((x) => x.id === id);
  if (!s) throw new Error(`specialist ${id} not found`);
  return s;
}

let n = 0;
function mkIssue(over: Partial<Issue>): Issue {
  return { id: `i${n++}`, dimension: "test_integrity", severity: 1, title: "t", file: "a.ts", line: 1, blastRadius: 1, ...over };
}

function emptyRepo(issues: Issue[] = []): RepoDetail {
  return {
    id: "r", url: "", name: "test", status: "done", sourceType: "git",
    score: 50, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null,
    loc: 100, languages: [], graphStats: { nodes: 0, edges: 0, files: 0, dirs: 0, dependencies: 0 },
    dimensions: [], issues, dependencies: [], churnByFile: {},
    tree: { name: "/", path: ".", children: [] },
    viz: { nodes: [], edges: [] } as any,
    modules: { nodes: [], edges: [] },
    symbolGraph: { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } },
  };
}

async function ctxFromFiles(files: FileInput[], issues: Issue[] = []): Promise<AgentContext> {
  const symbolGraph = await buildSymbolGraph(files, new Map());
  const repo = { ...emptyRepo(issues), symbolGraph };
  return { repo, qe: new QueryEngine(symbolGraph) };
}

describe("security specialist", () => {
  it("only surfaces security-dimension issues, capped at 40, and respects explicit confidence", () => {
    resetSeq();
    const ctx: AgentContext = {
      repo: emptyRepo([
        mkIssue({ dimension: "security", severity: 5, confidence: 0.42, title: "Use of eval()" }),
        mkIssue({ dimension: "correctness", severity: 5, title: "Leftover debug output" }),
      ]),
      qe: new QueryEngine({ symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } }),
    };
    const findings = specialist("security").run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Use of eval()");
    expect(findings[0].confidence).toBe(0.42); // explicit confidence passed through untouched
  });

  it("defaults confidence by severity when the issue carries none", () => {
    resetSeq();
    const ctx: AgentContext = {
      repo: emptyRepo([mkIssue({ dimension: "security", severity: 5, confidence: undefined, title: "Use of eval()" })]),
      qe: new QueryEngine({ symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } }),
    };
    const findings = specialist("security").run(ctx);
    expect(findings[0].confidence).toBe(0.9); // severity >= 4 default
  });
});

describe("performance specialist", () => {
  it("flags hub functions with fan-in >= 3, ignoring weakly-connected ones", async () => {
    resetSeq();
    // hub() called from 4 sites; quiet() called from 1 site.
    const callers = Array.from({ length: 4 }, (_, i) => `c${i}.ts`);
    const files: FileInput[] = [
      { rel: "hub.ts", ext: ".ts", language: "TypeScript", text: "export function hub() { return 1; }" },
      { rel: "quiet.ts", ext: ".ts", language: "TypeScript", text: "export function quiet() { return 1; }" },
      { rel: "c0.ts", ext: ".ts", language: "TypeScript", text: `import { quiet } from "./quiet";\nexport function run() { quiet(); }` },
      ...callers.map((rel) => ({
        rel, ext: ".ts", language: "TypeScript",
        text: `import { hub } from "./hub";\nexport function run() { hub(); }`,
      })),
    ];
    const ctx = await ctxFromFiles(files);
    const findings = specialist("performance").run(ctx);
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("hub"))).toBe(true);
    expect(titles.some((t) => t.includes("quiet"))).toBe(false); // fanIn 1 < 3, excluded
  });
});

describe("refactor specialist", () => {
  it("flags functions above the complexity-15 threshold and leaves simple ones alone", async () => {
    resetSeq();
    const complexBody = Array.from({ length: 20 }, (_, i) => `  if (x === ${i}) { y += 1; }`).join("\n");
    const files: FileInput[] = [
      { rel: "complex.ts", ext: ".ts", language: "TypeScript", text: `export function complex(x: number) {\n  let y = 0;\n${complexBody}\n  return y;\n}` },
      { rel: "simple.ts", ext: ".ts", language: "TypeScript", text: `export function simple() { return 1; }` },
    ];
    const ctx = await ctxFromFiles(files);
    const findings = specialist("refactor").run(ctx);
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("complex"))).toBe(true);
    expect(titles.some((t) => t.includes("simple"))).toBe(false);
  });
});

describe("deadcode specialist", () => {
  it("gives exported symbols lower confidence than unexported ones (might be a public API)", async () => {
    resetSeq();
    const files: FileInput[] = [
      { rel: "a.ts", ext: ".ts", language: "TypeScript", text: "export function unusedExported() { return 1; }" },
      { rel: "b.ts", ext: ".ts", language: "TypeScript", text: "function unusedPrivate() { return 1; }" },
    ];
    const ctx = await ctxFromFiles(files);
    const findings = specialist("deadcode").run(ctx);
    const exported = findings.find((f) => f.title.includes("unusedExported"));
    const priv = findings.find((f) => f.title.includes("unusedPrivate"));
    expect(exported).toBeDefined();
    expect(priv).toBeDefined();
    expect(exported!.confidence).toBeLessThan(priv!.confidence);
  });
});

describe("dependency specialist", () => {
  it("only surfaces dependency_hygiene issues", () => {
    resetSeq();
    const ctx: AgentContext = {
      repo: emptyRepo([
        mkIssue({ dimension: "dependency_hygiene", severity: 2, title: "No lockfile committed" }),
        mkIssue({ dimension: "security", severity: 5, title: "Use of eval()" }),
      ]),
      qe: new QueryEngine({ symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } }),
    };
    const findings = specialist("dependency").run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("No lockfile committed");
  });
});

describe("architecture specialist", () => {
  it("detects a real circular call dependency and gives tight (2-node) cycles higher confidence", async () => {
    resetSeq();
    const files: FileInput[] = [
      { rel: "a.ts", ext: ".ts", language: "TypeScript", text: `import { b } from "./b";\nexport function a() { return b(); }` },
      { rel: "b.ts", ext: ".ts", language: "TypeScript", text: `import { a } from "./a";\nexport function b() { return a(); }` },
    ];
    const ctx = await ctxFromFiles(files);
    const findings = specialist("architecture").run(ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].title).toMatch(/Circular dependency/);
    expect(findings[0].confidence).toBe(0.9); // 2-node cycle
  });

  it("reports no cycles for a strictly acyclic call graph", async () => {
    resetSeq();
    const files: FileInput[] = [
      { rel: "a.ts", ext: ".ts", language: "TypeScript", text: `import { b } from "./b";\nexport function a() { return b(); }` },
      { rel: "b.ts", ext: ".ts", language: "TypeScript", text: `export function b() { return 1; }` },
    ];
    const ctx = await ctxFromFiles(files);
    expect(specialist("architecture").run(ctx)).toHaveLength(0);
  });
});

describe("test specialist", () => {
  it("flags a high-fan-in function with zero test callers, but not one covered by a test file", async () => {
    resetSeq();
    const untested = Array.from({ length: 3 }, (_, i) => `u${i}.ts`);
    const files: FileInput[] = [
      { rel: "critical.ts", ext: ".ts", language: "TypeScript", text: "export function critical() { return 1; }" },
      { rel: "covered.ts", ext: ".ts", language: "TypeScript", text: "export function covered() { return 1; }" },
      ...untested.map((rel) => ({
        rel, ext: ".ts", language: "TypeScript",
        text: `import { critical } from "./critical";\nexport function run() { critical(); }`,
      })),
      { rel: "covered.test.ts", ext: ".ts", language: "TypeScript", text: `import { covered } from "./covered";\nexport function testCovered() { covered(); }` },
      ...Array.from({ length: 2 }, (_, i) => ({
        rel: `cov${i}.ts`, ext: ".ts", language: "TypeScript",
        text: `import { covered } from "./covered";\nexport function run() { covered(); }`,
      })),
    ];
    const ctx = await ctxFromFiles(files);
    const findings = specialist("test").run(ctx);
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("critical"))).toBe(true);
    expect(titles.some((t) => t.includes("covered"))).toBe(false);
  });
});

describe("security specialist: shallow taint reachability (Task 6.16)", () => {
  it("flags a request handler whose call chain reaches eval() two hops away", async () => {
    resetSeq();
    const files: FileInput[] = [
      // handler(req) -> processInput() -> runDynamic() -> eval(...)
      { rel: "handler.ts", ext: ".ts", language: "TypeScript", text: `import { processInput } from "./process";\nexport function handler(req: Request) { return processInput(req.body); }` },
      { rel: "process.ts", ext: ".ts", language: "TypeScript", text: `import { runDynamic } from "./dynamic";\nexport function processInput(x: any) { return runDynamic(x); }` },
      { rel: "dynamic.ts", ext: ".ts", language: "TypeScript", text: `export function runDynamic(code: string) {\n  return eval(code);\n}` },
    ];
    const symbolGraph = await buildSymbolGraph(files, new Map());
    const repo: RepoDetail = {
      ...emptyRepo([mkIssue({ dimension: "security", severity: 5, title: "Use of eval()", file: "dynamic.ts", line: 2, confidence: 0.95 })]),
      symbolGraph,
    };
    const ctx: AgentContext = { repo, qe: new QueryEngine(symbolGraph) };

    const findings = specialist("security").run(ctx);
    const taint = findings.find((f) => f.title.includes("Untrusted input reaches"));
    expect(taint).toBeDefined();
    expect(taint!.file).toBe("handler.ts"); // reported at the source (entry point), not the sink
    expect(taint!.detail).toMatch(/2 calls/);
    expect(taint!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does not flag a request handler whose call chain never reaches any security sink", async () => {
    resetSeq();
    const files: FileInput[] = [
      { rel: "handler.ts", ext: ".ts", language: "TypeScript", text: `import { formatInput } from "./format";\nexport function handler(req: Request) { return formatInput(req.body); }` },
      { rel: "format.ts", ext: ".ts", language: "TypeScript", text: `export function formatInput(x: any) { return String(x).trim(); }` },
    ];
    const symbolGraph = await buildSymbolGraph(files, new Map());
    const repo: RepoDetail = { ...emptyRepo([]), symbolGraph };
    const ctx: AgentContext = { repo, qe: new QueryEngine(symbolGraph) };

    const findings = specialist("security").run(ctx);
    expect(findings.some((f) => f.title.includes("Untrusted input reaches"))).toBe(false);
  });

  it("does not flag when eval() is in the SAME function as the source (no real multi-hop path)", async () => {
    resetSeq();
    // The base security filter over repo.issues already covers this case at depth 0;
    // taintFindings specifically must not double-report it as a "reachability" finding
    // since source and sink are the same symbol.
    const files: FileInput[] = [
      { rel: "handler.ts", ext: ".ts", language: "TypeScript", text: `export function handler(req: Request) {\n  return eval(req.body);\n}` },
    ];
    const symbolGraph = await buildSymbolGraph(files, new Map());
    const repo: RepoDetail = {
      ...emptyRepo([mkIssue({ dimension: "security", severity: 5, title: "Use of eval()", file: "handler.ts", line: 2, confidence: 0.95 })]),
      symbolGraph,
    };
    const ctx: AgentContext = { repo, qe: new QueryEngine(symbolGraph) };

    const findings = specialist("security").run(ctx);
    expect(findings.some((f) => f.title.includes("Untrusted input reaches"))).toBe(false);
    // The base (depth-0) finding is still present.
    expect(findings.some((f) => f.title === "Use of eval()")).toBe(true);
  });
});
