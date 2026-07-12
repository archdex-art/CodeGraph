import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";
import { runSwarm } from "@/lib/agents/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/agents -> RemediationPlan
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id);
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "done") return NextResponse.json({ error: "Repo not indexed yet" }, { status: 409 });
  try {
    return NextResponse.json(runSwarm(repo));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Swarm failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
