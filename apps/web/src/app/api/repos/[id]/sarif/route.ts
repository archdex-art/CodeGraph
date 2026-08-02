import { NextRequest, NextResponse } from "next/server";
import { toSarif } from "@codegraph/analysis-model";
import { getRepo } from "@/lib/store";
import { repoAccessDenied, viewerId } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/repos/:id/sarif — SARIF 2.1.0 download (LLD §13, ADR-006).
 *
 * The export adapter existed only in the design documents; HLD §3 named it as the mechanism
 * satisfying the interoperability requirement, so this was a claim with nothing behind it.
 *
 * Tenant isolation goes through the same `repoAccessDenied` + `viewerId(req)` pair every other
 * repo route uses. A download endpoint is exactly the kind of route that gets added without it
 * — the finding data here is no less sensitive for being in an interchange format.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;

  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });

  const log = toSarif(repo.issues ?? [], { endTimeUtc: new Date().toISOString() });

  return new NextResponse(JSON.stringify(log, null, 2), {
    headers: {
      "content-type": "application/sarif+json",
      // Named so a CI job downloading several repos does not overwrite one file repeatedly.
      "content-disposition": `attachment; filename="codegraph-${id}.sarif"`,
    },
  });
}
