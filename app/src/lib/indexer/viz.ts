import path from "node:path";
import type { GraphEdge, GraphNode, Issue, ModuleEdge, ModuleGraph, ModuleNode, TreeNode, VizGraph } from "../types";
import { LANG_BY_EXT } from "./constants";
import type { ScannedFile } from "./scan";

const VIZ_NODE_CAP = 350;

/** Build the renderable node/edge graph (files + dirs + import/containment edges). */
export function buildVizGraph(
  files: ScannedFile[],
  importEdges: Array<{ from: string; to: string }>,
  fanIn: Map<string, number>,
  issues: Issue[]
): VizGraph {
  // Per-file issue aggregation.
  const issueCount = new Map<string, number>();
  const worstSev = new Map<string, number>();
  for (const i of issues) {
    issueCount.set(i.file, (issueCount.get(i.file) || 0) + 1);
    worstSev.set(i.file, Math.max(worstSev.get(i.file) || 0, i.severity));
  }

  // Choose which files to render; keep highest-impact when over the cap.
  let chosen = files;
  let truncated = false;
  if (files.length > VIZ_NODE_CAP) {
    chosen = [...files]
      .sort(
        (a, b) =>
          (fanIn.get(b.rel) || 0) * 3 + b.loc / 100 - ((fanIn.get(a.rel) || 0) * 3 + a.loc / 100)
      )
      .slice(0, VIZ_NODE_CAP);
    truncated = true;
  }
  const included = new Set(chosen.map((f) => f.rel));

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const toPosix = (p: string) => p.split(path.sep).join("/");
  function ensureDir(dir: string): string {
    const id = dir === "" || dir === "." ? "." : dir;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: id === "." ? "/" : path.posix.basename(id),
        kind: "dir",
        language: null,
        loc: 0,
        fanIn: 0,
        issues: 0,
        worstSeverity: 0,
      });
    }
    return id;
  }
  // Build the directory chain and containment edges up to root.
  function linkChain(relFile: string) {
    const posix = toPosix(relFile);
    let dir = path.posix.dirname(posix);
    let child = posix;
    // file's immediate dir -> ... -> root
    while (true) {
      const dirId = ensureDir(dir);
      edges.push({ source: dirId, target: child, kind: "contains" });
      if (dir === "." || dir === "") break;
      child = dirId;
      dir = path.posix.dirname(dir);
    }
  }

  for (const f of chosen) {
    const posix = toPosix(f.rel);
    nodes.set(posix, {
      id: posix,
      label: path.posix.basename(posix),
      kind: "file",
      language: LANG_BY_EXT[f.ext] || null,
      loc: f.loc,
      fanIn: fanIn.get(f.rel) || 0,
      issues: issueCount.get(f.rel) || 0,
      worstSeverity: worstSev.get(f.rel) || 0,
    });
    linkChain(f.rel);
  }

  for (const e of importEdges) {
    if (included.has(e.from) && included.has(e.to)) {
      edges.push({ source: toPosix(e.from), target: toPosix(e.to), kind: "imports" });
    }
  }

  return { nodes: [...nodes.values()], edges, truncated };
}

/** Build the nested file tree for circle-packing (all files, not capped). */
export function buildTree(files: ScannedFile[], issuesByFile: Map<string, number>): TreeNode {
  const root: TreeNode = { name: "/", path: ".", children: [] };
  const dirCache = new Map<string, TreeNode>([[".", root]]);

  function ensureDir(dirPosix: string): TreeNode {
    if (dirCache.has(dirPosix)) return dirCache.get(dirPosix)!;
    const parentPath = path.posix.dirname(dirPosix);
    const parent = parentPath === dirPosix ? root : ensureDir(parentPath === "" ? "." : parentPath);
    const node: TreeNode = { name: path.posix.basename(dirPosix), path: dirPosix, children: [] };
    parent.children!.push(node);
    dirCache.set(dirPosix, node);
    return node;
  }

  for (const f of files) {
    const posix = f.rel.split(path.sep).join("/");
    const dirPosix = path.posix.dirname(posix);
    const parent = dirPosix === "." || dirPosix === "" ? root : ensureDir(dirPosix);
    parent.children!.push({
      name: path.posix.basename(posix),
      path: posix,
      ext: f.ext,
      loc: Math.max(1, f.loc),
      issues: issuesByFile.get(f.rel) || 0,
    });
  }
  return root;
}

/** Aggregate files into top-level modules + inter-module import edges (flowchart). */
export function buildModuleGraph(
  files: ScannedFile[],
  importEdges: Array<{ from: string; to: string }>,
  issuesByFile: Map<string, number>
): ModuleGraph {
  // Count files per top-level dir; big top dirs get expanded to 2 levels so the
  // architecture graph stays meaningful instead of a few giant blobs.
  const topCount = new Map<string, number>();
  for (const f of files) {
    const seg = f.rel.split(path.sep).join("/").split("/");
    const top = seg.length > 1 ? seg[0] : "(root)";
    topCount.set(top, (topCount.get(top) || 0) + 1);
  }
  const EXPAND_THRESHOLD = 12;
  const moduleOf = (rel: string): string => {
    const seg = rel.split(path.sep).join("/").split("/");
    if (seg.length <= 1) return "(root)";
    const top = seg[0];
    if (seg.length >= 3 && (topCount.get(top) || 0) > EXPAND_THRESHOLD) {
      return top + "/" + seg[1];
    }
    return top;
  };

  const mods = new Map<string, ModuleNode>();
  const langCount = new Map<string, Map<string, number>>();
  for (const f of files) {
    const id = moduleOf(f.rel);
    let m = mods.get(id);
    if (!m) {
      m = { id, label: id, files: 0, loc: 0, issues: 0, language: null, tier: 0 };
      mods.set(id, m);
      langCount.set(id, new Map());
    }
    m.files += 1;
    m.loc += f.loc;
    m.issues += issuesByFile.get(f.rel) || 0;
    const lang = LANG_BY_EXT[f.ext];
    if (lang) {
      const lc = langCount.get(id)!;
      lc.set(lang, (lc.get(lang) || 0) + 1);
    }
  }
  for (const [id, m] of mods) {
    const lc = langCount.get(id)!;
    let best: string | null = null;
    let bestN = 0;
    for (const [lang, n] of lc) if (n > bestN) { bestN = n; best = lang; }
    m.language = best;
  }

  const edgeW = new Map<string, ModuleEdge>();
  for (const e of importEdges) {
    const s = moduleOf(e.from);
    const t = moduleOf(e.to);
    if (s === t) continue;
    const key = s + "→" + t;
    const ex = edgeW.get(key);
    if (ex) ex.weight += 1;
    else edgeW.set(key, { source: s, target: t, weight: 1 });
  }
  const edges = [...edgeW.values()];

  // Assign tiers by longest-path depth (cycles broken by visited guard).
  const adj = new Map<string, string[]>();
  for (const m of mods.keys()) adj.set(m, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const tierOf = new Map<string, number>();
  function depth(node: string, seen: Set<string>): number {
    if (tierOf.has(node)) return tierOf.get(node)!;
    if (seen.has(node)) return 0;
    seen.add(node);
    let d = 0;
    for (const next of adj.get(node) || []) d = Math.max(d, 1 + depth(next, seen));
    seen.delete(node);
    tierOf.set(node, d);
    return d;
  }
  for (const m of mods.keys()) m && (mods.get(m)!.tier = depth(m, new Set()));

  return { nodes: [...mods.values()].sort((a, b) => a.tier - b.tier || b.loc - a.loc), edges };
}
