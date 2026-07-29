import { NextRequest, NextResponse } from "next/server";
import { deleteRepo, getRepo } from "@/lib/store";
import { repoAccessDenied, viewerId } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  return NextResponse.json(repo);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const removed = deleteRepo(id, viewerId(req));
  if (!removed) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
