import { CODE_EXTS } from "@codegraph/analysis-model";
import { isTestFile } from "../codeintel/query";
import type { IndexResult, TreeNode } from "../types";
import type { ArchitectureSnapshot } from "./types";
import {
  GOD_FILE_LOC,
  diffFiles,
  diffFindingsByRule,
  importCycles,
  type SeriesKey,
  type SnapshotDelta,
  type StructuralFacts,
  type TrendPoint,
} from "./timelineDelta";

/**
 * The compute half of `timelineDelta.ts` — everything that reads a whole `IndexResult`.
 *
 * Split from the shapes and labels because this side walks the render graph and the file
 * tree of every cached snapshot and pulls in the test-file classifier; the React view
 * needs only the labels and the delta shapes. Server-only by construction, not by
 * convention: nothing here is cheap enough to want in a client bundle.
 */

/**
 * `isTestFile` comes from `codeintel/query`, which already carries the sanctioned copy of
 * detect-engine's classifier and the note explaining why `apps/web` does not take that
 * dependency for one regex. Using the copy rather than making a second one keeps the
 * "change one, change both" contract at two sites instead of three.
 */
function* walkFiles(tree: TreeNode): Generator<TreeNode> {
  const stack: TreeNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children) stack.push(...node.children);
    else yield node;
  }
}

export function structuralFacts(result: IndexResult): StructuralFacts {
  const components = importCycles(result.viz);

  let godFiles = 0;
  let testFiles = 0;
  let totalFiles = 0;
  for (const file of walkFiles(result.tree)) {
    // The large-file rule fires on any scanned file with a line count, so this counts the
    // same population; the test ratio below is gated to CODE_EXTS because `analyzeTests` is.
    if ((file.loc ?? 0) > GOD_FILE_LOC) godFiles++;
    if (!file.ext || !CODE_EXTS[file.ext]) continue;
    totalFiles++;
    if (isTestFile(file.path)) testFiles++;
  }

  let maxFanIn = 0;
  for (const node of result.viz.nodes) {
    if (node.kind === "file" && node.fanIn > maxFanIn) maxFanIn = node.fanIn;
  }

  return {
    cycles: components.length,
    cycleFiles: components.reduce((n, c) => n + c.length, 0),
    godFiles,
    maxFanIn,
    dependencies: result.dependencies.length,
    testFiles,
    totalFiles,
    testRatio: totalFiles > 0 ? testFiles / totalFiles : 0,
    importGraphTruncated: result.viz.truncated,
  };
}

/**
 * One cached snapshot, reduced to the numbers the timeline plots.
 *
 * `archScore` is `NaN` rather than `0` when a snapshot predates the evolution pass:
 * a missing judgement is not a judgement of zero, and `formatSeries` renders it as such.
 */
export function trendPointOf(snapshot: ArchitectureSnapshot): TrendPoint {
  const facts = structuralFacts(snapshot.result);
  const values: Record<SeriesKey, number> = {
    cycles: facts.cycles,
    godFiles: facts.godFiles,
    maxFanIn: facts.maxFanIn,
    dependencies: facts.dependencies,
    testRatio: facts.testRatio,
    score: snapshot.result.score,
    archScore: snapshot.evolution?.metrics.architectureScore ?? Number.NaN,
  };
  return {
    hash: snapshot.timeline.hash,
    timestamp: snapshot.timeline.timestamp,
    message: snapshot.timeline.message,
    author: snapshot.timeline.author,
    values,
    facts,
    metrics: snapshot.metrics,
  };
}

/** Everything that moved between two snapshots: findings by rule, files, and the series. */
export function snapshotDelta(base: ArchitectureSnapshot, head: ArchitectureSnapshot): SnapshotDelta {
  return {
    base: trendPointOf(base),
    head: trendPointOf(head),
    findings: diffFindingsByRule(base.result.issues, head.result.issues),
    files: diffFiles(base.result.tree, head.result.tree),
  };
}
