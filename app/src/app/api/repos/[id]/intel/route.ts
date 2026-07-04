import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/store";
import { QueryEngine } from "@/lib/codeintel/query";
import { buildContext } from "@/lib/codeintel/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/intel?op=search&q=... | callers | callees | impact | context | cycles | deadcode | hubs
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = getRepo(id);
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });

  const g = repo.symbolGraph;
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "search";
  const q = url.searchParams.get("q") || "";
  const sym = url.searchParams.get("symbol") || "";
  const qe = new QueryEngine(g);

  switch (op) {
    case "search":
      return NextResponse.json({ results: qe.search(q, 40) });
    case "callers":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.callers(sym) });
    case "callees":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.callees(sym) });
    case "members":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.members(sym) });
    case "impact":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.impact(sym, 3) });
    case "cycles":
      return NextResponse.json({ cycles: qe.cycles() });
    case "deadcode":
      return NextResponse.json({ results: qe.deadCode().slice(0, 100) });
    case "hubs":
      return NextResponse.json({ results: qe.hubs(20) });
    case "context":
      return NextResponse.json(buildContext(g, q));
    default:
      return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
  }
}
