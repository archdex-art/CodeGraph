import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "@/lib/codeintel/graph";
import { runSwarm } from "@/lib/agents/orchestrator";
import type { RepoDetail } from "@/lib/types";

// Acceptance test for Phase 6.11: "A high-fan-in, frequently-committed file
// ranks above an equally-high-fan-in, untouched-in-a-year file, all else equal."
describe("git churn feeds judge scoring (Task 6.11)", () => {
  it("ranks the hotspot (high fan-in + high churn) above an equally-connected but untouched file", async () => {
    // Two files, each defining a function called from 5 sites elsewhere — identical
    // fan-in — so any score difference must come from churn, not blast radius.
    const callSites = Array.from({ length: 5 }, (_, i) => `caller${i}.ts`);
    const files = [
      { rel: "hot.ts", ext: ".ts", language: "TypeScript", text: `export function hot() { return 1; }` },
      { rel: "cold.ts", ext: ".ts", language: "TypeScript", text: `export function cold() { return 1; }` },
      ...callSites.map((rel) => ({
        rel,
        ext: ".ts",
        language: "TypeScript",
        text: `import { hot } from "./hot";\nimport { cold } from "./cold";\nexport function run() { hot(); cold(); }`,
      })),
    ];
    const symbolGraph = await buildSymbolGraph(files, new Map());

    const repo: RepoDetail = {
      id: "r", url: "", name: "test", status: "done", sourceType: "git",
      score: 80, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null,
      loc: 100, languages: [], graphStats: { nodes: 0, edges: 0, files: 0, dirs: 0, dependencies: 0 },
      dimensions: [], issues: [], dependencies: [],
      churnByFile: { "hot.ts": 50, "cold.ts": 1 }, // hot.ts committed 50x in the window, cold.ts once
      tree: { name: "/", path: ".", children: [] },
      viz: { nodes: [], edges: [] } as any,
      modules: { nodes: [], edges: [] },
      symbolGraph,
    };

    const plan = runSwarm(repo);
    const hotFinding = plan.topFindings.find((f) => f.title.includes("hot"));
    const coldFinding = plan.topFindings.find((f) => f.title.includes("cold"));

    expect(hotFinding).toBeDefined();
    expect(coldFinding).toBeDefined();
    // Same fan-in (5 callers each), same severity bucket -> churn must be what separates them.
    expect(hotFinding!.score!).toBeGreaterThan(coldFinding!.score!);
  });
});
