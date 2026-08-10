import { NextRequest, NextResponse } from "next/server";
import { repoAccessDenied, requireWorkspace } from "@/lib/authz";
import { listTrash, restoreFromTrash, purgeTrashEntry, emptyTrash } from "@/lib/trash";
import { WorkspacePathError } from "@codegraph/fsx";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(e: unknown, fallback = 500) {
  // Same policy as the fs route, which this used to differ from: WorkspacePathError
  // messages are authored to be client-safe, but a raw ENOENT/EEXIST from node:fs embeds
  // the server's ABSOLUTE workspace path — and every trash operation is a filesystem move,
  // so those were the common case here. Returning them disclosed the data directory
  // layout to any caller who could name a missing entry (F023).
  if (e instanceof WorkspacePathError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  logger.warn("trash route error", { error: e instanceof Error ? e.message : String(e) });
  return NextResponse.json({ error: "Trash operation failed" }, { status: fallback });
}

// GET /api/repos/:id/trash -> { entries: TrashEntry[] }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
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
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const { op, trashId } = body as { op: string; trashId?: string };
  try {
    if (op === "restore") {
      /*
       * Through `requireWorkspace`, not `getWorkspaceDir`, so restoring a file lands in a tree
       * that actually exists: repositories are cloned `--no-checkout` and materialised on
       * first file access. This was the one route reaching past the shared guard, which also
       * meant it was the one route not getting the guard's access semantics.
       */
      const { denied: noWs, ws } = requireWorkspace(req, id);
      if (noWs) return noWs;
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
