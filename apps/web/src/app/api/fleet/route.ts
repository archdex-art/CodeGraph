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
 * Package name -> the repository that publishes it.
 *
 * WHAT THIS USED TO KEY ON, AND WHY IT FOUND NOTHING
 *
 * It indexed repositories by DISPLAY NAME (`CodeGraph`, `sindresorhus/slugify`) and then
 * matched other repositories' declared DEPENDENCY names (`@codegraph/analysis`, `react`)
 * against it. Those are different namespaces, and they coincide only by luck: this monorepo is
 * displayed as `CodeGraph` and publishes `@codegraph/analysis`. Measured here: 12 repositories,
 * 0 edges — while `/api/org`, a second implementation keyed on manifest names, found 14 across
 * the same set. The page said "dependency edges between indexed repositories" and drew none.
 *
 * Manifest-declared names come first because they are the real answer. The display name is
 * kept as a fallback, since a repository whose manifests were never parsed can still be the
 * obvious target for `gorilla/mux`, and losing that would trade one silent gap for another.
 */
function indexByName(repos: readonly FleetRepo[]): Map<string, string> {
  const byName = new Map<string, string>();
  const claim = (key: string, id: string) => {
    const k = key.trim().toLowerCase();
    // First claim wins, so a precise key is never overwritten by a looser one added later.
    if (k && !byName.has(k)) byName.set(k, id);
  };
  for (const r of repos) for (const pkg of r.packageNames) claim(pkg, r.id);
  for (const r of repos) claim(r.name, r.id);
  for (const r of repos) {
    const name = r.name.toLowerCase();
    claim(name.slice(name.lastIndexOf("/") + 1), r.id);
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
      // Movement since the previous index — what the fleet index below the graph ranks
      // by. Computed in one query beside the rows, not per node.
      drift: r.drift,
      // The fleet index ranks these by score, so a score computed over a truncated walk has
      // to say so where it is compared against whole-repository ones.
      capHit: r.capHit,
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
