import { NextRequest, NextResponse } from "next/server";
import { viewerId } from "@/lib/authz";
import { getRepo, listRepos } from "@/lib/store";
import { buildOrgGraph, type OrgRepoInput } from "@/lib/orggraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/org — the cross-repository knowledge graph.
 *
 * TENANCY IS THE WHOLE RISK HERE, and it is why this route resolves each repository through
 * `getRepo(id, viewer)` rather than reading rows directly. Every other repo route is scoped to
 * one id that `repoAccessDenied` has already checked; this one spans MANY, so a single
 * unscoped query would return private repositories to anyone who asked — the exact
 * cross-tenant leak this codebase has already had to close once (Phase 0.6).
 *
 * The scoping is enforced twice over, deliberately. `listRepos(viewer)` applies the
 * `owner_id IS NULL OR owner_id = ?` predicate in SQL, and `getRepo(id, viewer)` applies it
 * again per row. The second pass is not redundant: it means a future change to the listing
 * query cannot silently widen what this route returns, because the detail fetch would still
 * refuse. A repo that vanishes between the two calls simply contributes nothing.
 */
export async function GET(req: NextRequest) {
  const viewer = viewerId(req);

  const inputs: OrgRepoInput[] = [];
  for (const summary of listRepos(viewer)) {
    // Only completed indexes carry the manifests and ownership this graph is built from. A
    // queued or failed repo is not evidence of anything and is left out rather than reported
    // as a node with no edges, which would read as "this repo depends on nothing".
    if (summary.status !== "done") continue;
    const repo = getRepo(summary.id, viewer);
    if (!repo) continue;
    inputs.push({
      id: repo.id,
      name: repo.name,
      dependencies: repo.dependencies,
      packageNames: repo.packageNames ?? [],
      ownership: repo.ownership,
    });
  }

  return NextResponse.json(buildOrgGraph(inputs));
}
