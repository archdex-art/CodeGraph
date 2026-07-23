import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import { searchWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/search?q=needle -> { results: SearchMatch[] }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") || "";
  const results = searchWorkspace(ws.dir, q, 200);
  return NextResponse.json({ results });
}
