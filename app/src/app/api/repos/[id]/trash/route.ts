import { NextResponse } from "next/server";
import { getWorkspaceDir } from "@/lib/store";
import { listTrash, restoreFromTrash, purgeTrashEntry, emptyTrash } from "@/lib/trash";
import { WorkspacePathError } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(e: unknown, fallback = 500) {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof WorkspacePathError ? 400 : fallback;
  return NextResponse.json({ error: msg }, { status });
}

// GET /api/repos/:id/trash -> { entries: TrashEntry[] }
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ entries: listTrash(id) });
  } catch (e) {
    return err(e);
  }
}

// POST /api/repos/:id/trash
// { op: "restore", trashId } -> moves the entry back to its original path
// { op: "purge", trashId }   -> permanently erases one entry
// { op: "empty" }            -> permanently erases every entry for this repo
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { op, trashId } = body as { op: string; trashId?: string };
  try {
    if (op === "restore") {
      const ws = getWorkspaceDir(id);
      if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
      if (!trashId) return NextResponse.json({ error: "Missing trashId" }, { status: 400 });
      return NextResponse.json({ ok: true, entry: restoreFromTrash(id, ws.dir, trashId) });
    }
    if (op === "purge") {
      if (!trashId) return NextResponse.json({ error: "Missing trashId" }, { status: 400 });
      purgeTrashEntry(id, trashId);
      return NextResponse.json({ ok: true });
    }
    if (op === "empty") {
      emptyTrash(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 400);
  }
}
