import { NextResponse } from "next/server";
import { deleteRepo, getRepo } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = getRepo(id);
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  return NextResponse.json(repo);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const removed = deleteRepo(id);
  if (!removed) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
