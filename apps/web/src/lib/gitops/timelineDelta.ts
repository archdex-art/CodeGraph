import { findingKey, ruleIdOf } from "@codegraph/analysis-model";
import type { Issue, TreeNode, VizGraph } from "../types";
import type { TimelineSnapshot } from "./timeline";
import type { SnapshotMetrics } from "./types";

/**
 * What the timeline trends, and how two points on it differ.
 *
 * Client-safe on purpose: the compute half (`structuralFacts.ts`) walks the render graph
 * and the file tree of a whole snapshot and reaches for the test-file classifier. The
 * React view needs only the series LABELS and the delta SHAPES at runtime, so they live
 * here, where the only dependency is the zero-runtime-dep `@codegraph/analysis-model`
 * (see that package's header for why it was carved out).
 *
 * WHY THIS EXISTS AT ALL. The timeline used to trend one number — the Health Score —
 * which IDENTITY.md itself says is uncalibrated. "Score 74 → 71" tells a reader
 * nothing they can act on; "cycles 3 → 11" tells them exactly what to open. So each
 * series declares whether it is a MEASURED fact (counted off the graph, checkable by
 * hand) or a SCORED judgement (a weighted opinion), and the view says which is which
 * rather than plotting them as if they were the same kind of thing.
 */

export type SeriesKind = "measured" | "scored";

export type SeriesKey =
  | "cycles"
  | "godFiles"
  | "maxFanIn"
  | "dependencies"
  | "testRatio"
  | "score"
  | "archScore";

export interface SeriesDef {
  key: SeriesKey;
  label: string;
  kind: SeriesKind;
  format: "int" | "percent";
  /** Which direction is an improvement, for colouring a delta. `null` = neither. */
  better: "lower" | "higher" | null;
  info: string;
}

/** This repository's own god-file bar, mirrored from detect-engine's `large-file` rule. */
export const GOD_FILE_LOC = 600;

export const TIMELINE_SERIES: readonly SeriesDef[] = [
  {
    key: "cycles",
    label: "Import cycles",
    kind: "measured",
    format: "int",
    better: "lower",
    info: "Strongly-connected components of the file-level import graph (size > 1, or a self-import). Counted, not scored.",
  },
  {
    key: "godFiles",
    label: `Files > ${GOD_FILE_LOC} LOC`,
    kind: "measured",
    format: "int",
    better: "lower",
    info: `Source files above this repository's own ${GOD_FILE_LOC}-line bar — the same threshold the large-file rule fires on.`,
  },
  {
    key: "maxFanIn",
    label: "Max fan-in",
    kind: "measured",
    format: "int",
    better: null,
    info: "How many files import the single most-imported file. The blast radius of the worst change to make.",
  },
  {
    key: "dependencies",
    label: "Dependencies",
    kind: "measured",
    format: "int",
    better: null,
    info: "Third-party packages this snapshot's manifests declare.",
  },
  {
    key: "testRatio",
    label: "Test-file ratio",
    kind: "measured",
    format: "percent",
    better: "higher",
    info: "Share of source files that are test files, by the same classifier the no-tests rule uses.",
  },
  {
    key: "score",
    label: "Health Score",
    kind: "scored",
    format: "int",
    better: "higher",
    info: "A weighted judgement, not a measurement. Uncalibrated — read the measured series above it before this one.",
  },
  {
    key: "archScore",
    label: "Arch Score",
    kind: "scored",
    format: "int",
    better: "higher",
    info: "A second weighted judgement, over issue severity, fan-in and codebase size. Also uncalibrated.",
  },
];

/** Structural facts read straight off one snapshot's index result. */
export interface StructuralFacts {
  cycles: number;
  /** Files caught in those cycles — a 2-file cycle and a 20-file one are not one problem. */
  cycleFiles: number;
  godFiles: number;
  maxFanIn: number;
  dependencies: number;
  testFiles: number;
  totalFiles: number;
  /** `testFiles / totalFiles`, 0..1. */
  testRatio: number;
  /**
   * The import graph is the RENDER graph, capped at 350 files (`VIZ_NODE_CAP`).
   *
   * When this is true, `cycles` is a LOWER BOUND: the cap keeps the highest-impact
   * files, so a cycle confined to low-impact ones is not visible. `maxFanIn` is
   * unaffected — the cap sorts by fan-in first, so the maximum is always kept.
   */
  importGraphTruncated: boolean;
}

/** One point on the timeline, with everything the chart and the compare table need. */
export interface TrendPoint {
  hash: string;
  timestamp: number;
  message: string;
  author: string;
  values: Record<SeriesKey, number>;
  facts: StructuralFacts;
  /** The pre-existing per-snapshot metrics, unchanged — other callers still read these. */
  metrics: SnapshotMetrics;
}

export interface RuleDelta {
  rule: string;
  added: number;
  removed: number;
  /** Files that gained a finding of this rule, and files that lost one. */
  addedFiles: string[];
  removedFiles: string[];
}

export interface FindingDelta {
  added: number;
  removed: number;
  /** Sorted by the size of the change, because the biggest mover is the story. */
  byRule: RuleDelta[];
}

export interface SnapshotDelta {
  base: TrendPoint;
  head: TrendPoint;
  findings: FindingDelta;
  files: { added: string[]; removed: string[] };
}

/**
 * Findings added and removed between two snapshots, grouped by rule id.
 *
 * Identity is `findingKey` — RULE and FILE, not line — so moving a secret down a file
 * is not reported as one fix plus one regression. Counted as a MULTISET per key: a file
 * that went from three hardcoded secrets to five reports two added, not zero.
 *
 * `ruleIdOf` rather than `title`, because titles interpolate ("Large file (812 LOC)")
 * and would group every god-file as its own rule.
 */
export function diffFindingsByRule(
  base: readonly Issue[],
  head: readonly Issue[]
): FindingDelta {
  const baseCounts = countByKey(base);
  const headCounts = countByKey(head);

  const byRule = new Map<string, RuleDelta>();
  const take = (rule: string): RuleDelta => {
    let d = byRule.get(rule);
    if (!d) {
      d = { rule, added: 0, removed: 0, addedFiles: [], removedFiles: [] };
      byRule.set(rule, d);
    }
    return d;
  };

  let added = 0;
  let removed = 0;
  for (const key of new Set([...baseCounts.keys(), ...headCounts.keys()])) {
    const before = baseCounts.get(key)?.count ?? 0;
    const after = headCounts.get(key)?.count ?? 0;
    if (before === after) continue;
    // Either map has the key whenever the counts differ, and both agree on rule/file.
    const { rule, file } = (headCounts.get(key) ?? baseCounts.get(key))!;
    const d = take(rule);
    if (after > before) {
      d.added += after - before;
      added += after - before;
      d.addedFiles.push(file);
    } else {
      d.removed += before - after;
      removed += before - after;
      d.removedFiles.push(file);
    }
  }

  for (const d of byRule.values()) {
    d.addedFiles.sort();
    d.removedFiles.sort();
  }

  const sorted = [...byRule.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || a.rule.localeCompare(b.rule)
  );
  return { added, removed, byRule: sorted };
}

function countByKey(
  issues: readonly Issue[]
): Map<string, { rule: string; file: string; count: number }> {
  const counts = new Map<string, { rule: string; file: string; count: number }>();
  for (const issue of issues) {
    const key = findingKey(issue);
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { rule: ruleIdOf(issue), file: issue.file, count: 1 });
  }
  return counts;
}

/** Files present in one snapshot's tree and not the other. */
export function diffFiles(base: TreeNode, head: TreeNode): { added: string[]; removed: string[] } {
  const before = filePaths(base);
  const after = filePaths(head);
  return {
    added: [...after].filter((p) => !before.has(p)).sort(),
    removed: [...before].filter((p) => !after.has(p)).sort(),
  };
}

export function filePaths(tree: TreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (node: TreeNode) => {
    if (node.children) node.children.forEach(walk);
    else out.add(node.path);
  };
  walk(tree);
  return out;
}

/**
 * Strongly-connected components of the file-level import graph (Tarjan, iterative).
 *
 * Iterative rather than recursive because the caller hands it a whole repository's
 * import graph and a deep chain would blow the stack on the server.
 */
export function importCycles(viz: VizGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of viz.edges) {
    if (edge.kind !== "imports") continue;
    nodes.add(edge.source);
    nodes.add(edge.target);
    const outgoing = adjacency.get(edge.source);
    if (outgoing) outgoing.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const root of nodes) {
    if (index.has(root)) continue;
    // Each frame is [node, next-child-to-visit], standing in for the recursive call.
    const work: Array<[string, number]> = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, resumeAt] = frame;
      if (resumeAt === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const children = adjacency.get(node) ?? [];
      let descended = false;
      for (let i = resumeAt; i < children.length; i++) {
        const child = children[i];
        if (!index.has(child)) {
          frame[1] = i + 1;
          work.push([child, 0]);
          descended = true;
          break;
        }
        if (onStack.has(child)) low.set(node, Math.min(low.get(node)!, index.get(child)!));
      }
      if (descended) continue;

      if (low.get(node) === index.get(node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== node);
        // A single node is only a cycle if it imports itself.
        if (component.length > 1 || children.includes(node)) components.push(component);
      }
      work.pop();
      const parent = work[work.length - 1]?.[0];
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
    }
  }
  return components;
}

/**
 * Formats a series value for display; percent series are stored as 0..1.
 *
 * A non-finite value means the snapshot never carried that series — a pre-evolution cache
 * has no Arch Score — and renders as an em dash. Rendering it as `0` would put a fabricated
 * worst-possible judgement on the chart.
 */
export function formatSeries(def: SeriesDef, value: number): string {
  if (!Number.isFinite(value)) return "—";
  return def.format === "percent" ? `${(value * 100).toFixed(1)}%` : String(Math.round(value));
}

/** Signed change between two points on one series, in that series' own unit. */
export function formatDelta(def: SeriesDef, base: number, head: number): string {
  if (!Number.isFinite(base) || !Number.isFinite(head)) return "—";
  if (def.format === "percent") {
    const pp = (head - base) * 100;
    // Points, not percent: a ratio moving 10% → 12% moved two POINTS, and calling that
    // "+20%" is the oldest way to make a small change look like a big one.
    return `${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(1)}pp`;
  }
  const d = Math.round(head) - Math.round(base);
  return d === 0 ? "±0" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`;
}

export type DeltaTone = "better" | "worse" | "neutral";

/** Whether a move on this series is an improvement — `neutral` when the series has no good direction. */
export function deltaTone(def: SeriesDef, base: number, head: number): DeltaTone {
  if (def.better === null || !Number.isFinite(base) || !Number.isFinite(head)) return "neutral";
  const d = head - base;
  if (d === 0) return "neutral";
  return (d > 0) === (def.better === "higher") ? "better" : "worse";
}

/** The bare timeline metadata a TrendPoint carries forward from its commit. */
export function commitOf(point: TrendPoint): Pick<TimelineSnapshot, "hash" | "message" | "author"> {
  return { hash: point.hash, message: point.message, author: point.author };
}
