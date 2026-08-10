import { NextRequest, NextResponse } from "next/server";
import { repoAccessDenied, viewerId } from "@/lib/authz";
import { getRepo } from "@/lib/store";
import { replacementImpact } from "@codegraph/analysis";
import { QueryEngine } from "@/lib/codeintel/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A package name from a query string.
 *
 * Never reaches a filesystem path or a subprocess — it is compared against strings already in
 * the index — but it IS used to build a `RegExp` in `replacementImpact`, so an unbounded value
 * is a ReDoS surface. npm's own naming rules are narrower than this and every other ecosystem's
 * are too, so anything outside it cannot name a real package.
 */
const PACKAGE = /^[@a-zA-Z0-9._/-]{1,214}$/;

// GET /api/repos/:id/dependencies?op=advisories | unused | impact&package=…
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") || "advisories";

  if (op === "advisories") {
    /**
     * ABSENT and `status: "disabled"` are DIFFERENT answers and both are returned as-is.
     *
     * Absent means the run predates advisory lookup. `disabled` means this deployment did not
     * ask for one. `unavailable` means we tried and could not. Only `checked` licenses the
     * reader to conclude anything about vulnerabilities, and flattening any of the other three
     * into an empty list would turn "we did not look" into "there is nothing there" — the one
     * failure this whole feature is shaped to prevent.
     */
    if (!repo.advisories) {
      return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
    }
    return NextResponse.json(repo.advisories);
  }

  if (op === "unused") {
    if (!repo.unusedDependencies) {
      return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
    }
    // Candidates with a confidence and a caveat, never a verdict — the shape says so and the
    // UI must render both, or a 0.15-confidence guess reads like a fact.
    return NextResponse.json({ candidates: repo.unusedDependencies });
  }

  if (op === "impact") {
    const pkg = searchParams.get("package");
    if (!pkg || !PACKAGE.test(pkg)) {
      return NextResponse.json({ error: "Missing or malformed package" }, { status: 400 });
    }
    /**
     * Import sites are found by scanning source text, and the stored index does not keep file
     * CONTENTS — only the graph, the viz nodes and the findings. So this answers from the
     * symbol graph alone and says which half it could not compute, rather than silently
     * returning an empty `importSites` that reads as "nothing imports this".
     */
    const qe = new QueryEngine(repo.symbolGraph);
    const impact = replacementImpact(pkg, [], repo.symbolGraph, qe);
    return NextResponse.json({
      ...impact,
      note: "import sites need file contents, which the stored index does not retain; blast radius is from the symbol graph",
    });
  }

  return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
}
