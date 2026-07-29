import { NextRequest, NextResponse } from "next/server";
import { listFleetRepos } from "@/lib/store";
import { viewerId } from "@/lib/authz";
import type { FleetGraph, FleetNode, FleetEdge, FleetRepo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cross-repo dependency graph over the repos a viewer can see.
 *
 * ONE query serves the whole response, whatever the repo count. The previous
 * version called `getRepo` per repo, which loaded and JSON-parsed the full row
 * — symbol graph included, megabytes for a large codebase — to read a single
 * short array off it (REVIEW B7). `listFleetRepos` selects the seven columns
 * the graph actually draws with.
 *
 * WHAT THE EDGES MEAN, AND WHAT THEY DO NOT. An edge is inferred by matching a
 * declared dependency name against the names of other repos in the fleet. It is
 * a name match, not a provenance match: a repo named `express` will be pointed
 * at by everything depending on the npm package `express`, whether or not it is
 * that package's source. The indexer records dependency names only — no
 * registry URL, no resolved integrity hash — so there is nothing to
 * disambiguate with here, and moving that resolution into indexing is a
 * separate change. Within a fleet of an organisation's own repos, which is what
 * this view is for, the collision is rare and a wrong edge is visible.
 */

/**
 * Repo name (lowercased) → repo id, keyed by both the full `owner/repo` name
 * and its bare last segment, because dependencies are declared as `express`
 * while repos are named `expressjs/express`.
 *
 * Two passes, not one, so precedence is deterministic and does not depend on
 * row order: an exact full-name match always beats another repo's bare segment.
 * Between two repos with the same bare segment the first row wins, and the
 * query's `ORDER BY created_at DESC, id ASC` makes "first" stable.
 */
function indexByName(repos: readonly FleetRepo[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const r of repos) {
    const name = r.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, r.id);
  }
  for (const r of repos) {
    const name = r.name.toLowerCase();
    const bare = name.slice(name.lastIndexOf("/") + 1);
    if (bare && !byName.has(bare)) byName.set(bare, r.id);
  }
  return byName;
}

export async function GET(req: NextRequest) {
  const repos = listFleetRepos(viewerId(req));
  const byName = indexByName(repos);

  const nodes: FleetNode[] = [];
  const edges: FleetEdge[] = [];

  for (const r of repos) {
    nodes.push({
      id: r.id,
      name: r.name,
      url: r.url,
      score: r.score,
      sourceType: r.sourceType,
      loc: r.loc,
    });

    // Per-source, so one repo listing the same package twice (or listing both
    // `express` and `expressjs/express`) yields one edge, not two.
    const linked = new Set<string>();
    for (const d of r.dependencies) {
      const target = byName.get(d.toLowerCase());
      if (target === undefined || target === r.id) continue; // no self-edges
      if (linked.has(target)) continue;
      linked.add(target);
      edges.push({ source: r.id, target });
    }
  }

  const graph: FleetGraph = { nodes, edges };
  return NextResponse.json(graph);
}
