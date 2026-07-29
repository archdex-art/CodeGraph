import { NextRequest, NextResponse } from "next/server";
import { listRepos, getRepo } from "@/lib/store";
import { viewerId } from "@/lib/authz";
import type { FleetGraph, FleetNode, FleetEdge } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const summaries = listRepos(viewerId(req));
  const nodes: FleetNode[] = [];
  const edges: FleetEdge[] = [];
  
  // We need the full detail for dependencies, or at least the deps list.
  // Since listRepos doesn't return deps, we fetch getRepo for each.
  // In a real enterprise system, we'd add `deps` to listRepos or a specific query.
  for (const s of summaries) {
    if (s.status !== "done") continue;
    const r = getRepo(s.id);
    if (!r) continue;
    
    nodes.push({
      id: r.id,
      name: r.name,
      url: r.url,
      score: r.score,
      sourceType: r.sourceType,
      loc: r.loc
    });
    
    // Exact match repo name (e.g., 'express') to dependency list
    // This is naive string matching for the spike
    for (const d of r.dependencies) {
      const target = summaries.find(x => x.name.toLowerCase() === d.toLowerCase() || x.name.toLowerCase().endsWith('/' + d.toLowerCase()));
      if (target && target.id !== r.id) {
        edges.push({ source: r.id, target: target.id });
      }
    }
  }

  const graph: FleetGraph = { nodes, edges };
  return NextResponse.json(graph);
}
