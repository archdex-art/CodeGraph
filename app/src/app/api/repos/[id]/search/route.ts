import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceDir } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";
import { searchWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/search?q=needle -> { results: SearchMatch[] }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const ws = getWorkspaceDir(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") || "";
  const results = searchWorkspace(ws.dir, q, 200);
  return NextResponse.json({ results });
}
