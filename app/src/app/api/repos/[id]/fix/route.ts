import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";
import { executeFixes } from "@/lib/agents/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// POST /api/repos/:id/fix -> FixResult (verified remediation patch + PR draft)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id);
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "done") return NextResponse.json({ error: "Repo not indexed yet" }, { status: 409 });
  try {
    const body = await req.json().catch(() => ({}));
    const result = await executeFixes(repo, body.githubToken);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Executor failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
