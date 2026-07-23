import { rmSync } from "node:fs";
import path from "node:path";
import type { GraphStats, IndexResult } from "../types";
import { buildSymbolGraph } from "../codeintel/graph";
import { extractorFor } from "../codeintel/extractors";
import { analyzeDependencies, analyzeFiles, analyzeTests, computeChurn, resetIssueSeq } from "./analyze";
import { LANG_BY_EXT } from "./constants";
import { computeImportGraph, scan } from "./scan";
import { score } from "./score";
import { buildModuleGraph, buildTree, buildVizGraph } from "./viz";

export { cloneRepo, redactCredentials, resolveLocalDir } from "./clone";

/** Full pipeline: scan a repo/folder dir → result (graph + score + viz). */
export async function indexRepo(root: string): Promise<IndexResult> {
  resetIssueSeq();
  const churnMap = computeChurn(root);
  const { files, languages, loc } = await scan(root);
  const { fanIn, importEdges } = await computeImportGraph(files);

  const dep = analyzeDependencies(root);
  const codeIssues = await analyzeFiles(files, fanIn, churnMap);
  const testIssues = analyzeTests(files);
  const issues = [...codeIssues, ...dep.issues, ...testIssues];

  const dirCount = new Set(
    files.map((f) => path.posix.dirname(f.rel.split(path.sep).join("/")))
  ).size;
  const graphStats: GraphStats = {
    files: files.length,
    dirs: dirCount,
    dependencies: dep.count,
    nodes: files.length + dirCount + dep.count,
    edges: importEdges.length + files.length, // imports + containment
  };

  const { dimensions, overall } = score(issues, loc);
  issues.sort((a, b) => b.severity * b.blastRadius - a.severity * a.blastRadius);

  // Per-file issue counts (shared by viz, tree, modules).
  const issuesByFile = new Map<string, number>();
  for (const i of issues) issuesByFile.set(i.file, (issuesByFile.get(i.file) || 0) + 1);

  const viz = buildVizGraph(files, importEdges, fanIn, issues);
  const tree = buildTree(files, issuesByFile);
  const modules = buildModuleGraph(files, importEdges, issuesByFile);

  // Symbol-level knowledge graph (code intelligence layer).
  const symbolGraph = await buildSymbolGraph(
    files
      .filter((f) => f.text && extractorFor(f.ext))
      .map((f) => ({
        rel: f.rel.split(path.sep).join("/"),
        ext: f.ext,
        text: f.text,
        language: LANG_BY_EXT[f.ext] || "unknown",
      })),
    issuesByFile
  );

  return {
    loc,
    languages,
    graphStats,
    dimensions,
    issues: issues.slice(0, 200),
    dependencies: dep.depsList,
    churnByFile: Object.fromEntries(churnMap),
    score: overall,
    viz,
    tree,
    modules,
    symbolGraph,
  };
}

export function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
