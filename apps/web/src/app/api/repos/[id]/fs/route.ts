import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import { logger } from "@codegraph/observability";
import {
  listDir,
  readWorkspaceFile,
  readWorkspaceBytes,
  writeWorkspaceFile,
  writeWorkspaceBytes,
  createEntry,
  renameEntry,
  duplicateEntry,
  WorkspacePathError,
  MAX_WRITE_BYTES,
} from "@codegraph/fsx";
import { moveToTrash } from "@/lib/trash";
import { scheduleReindex } from "@/lib/store";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(e: unknown, fallback = 500) {
  // WorkspacePathError messages are authored to be client-safe (no absolute
  // paths); everything else (raw ENOENT/EISDIR from node:fs) embeds the
  // server's absolute workspace path — log it server-side, return a generic
  // message to the client (F023).
  if (e instanceof WorkspacePathError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  logger.warn("fs route error", { error: e instanceof Error ? e.message : String(e) });
  return NextResponse.json({ error: "File operation failed" }, { status: fallback });
}

// GET /api/repos/:id/fs?op=list&path=src         -> FsEntry[]
// GET /api/repos/:id/fs?op=read&path=src/index.ts -> { content, truncated, size, binary }
// GET /api/repos/:id/fs?op=download&path=a/b.png  -> raw file bytes (download)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") || "list";
  const relPath = searchParams.get("path") || ".";
  try {
    if (op === "list") return NextResponse.json({ entries: listDir(ws.dir, relPath) });
    if (op === "read") return NextResponse.json(readWorkspaceFile(ws.dir, relPath));
    if (op === "download") {
      const { bytes, name } = readWorkspaceBytes(ws.dir, relPath);
      // A filename with `"`, `\`, or non-ASCII bytes corrupts a quoted
      // Content-Disposition header (Next.js rejects it -> 500, and raw CR/LF
      // would enable header injection). Emit an ASCII-sanitized fallback plus
      // an RFC 5987 UTF-8 encoded `filename*` for correct clients.
      //
      // Kept from main (PR #24/#25) on top of this branch's `readWorkspaceBytes`:
      // the fsx capability returns `path.basename(full)` UNSANITIZED, so dropping
      // this in favour of "our" side would have silently reintroduced the
      // injection. The sanitization belongs at the header, not in fsx — fsx
      // returns a filename, and only this caller puts one in a header.
      const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      return new NextResponse(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 404);
  }
}

// POST /api/repos/:id/fs
// { op: "write"|"create"|"rename"|"duplicate"|"upload", path, to?, type?, content?, contentBase64? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // MAX_WRITE_BYTES caps ONE write at 8 MB; nothing capped how MANY. An anonymous
  // `op=upload` loop against a public-bucket repo fills the 1 GB Render volume that also
  // holds codegraph.sqlite, at which point the whole app loses the ability to write —
  // not just this repo. 60/min is well above the editor's real burst (autosave is
  // coalesced and ~1/s only while typing) and bounds the worst case to ~480 MB/min.
  // Above `requireWorkspace` deliberately: the tenant check passes for anyone on a
  // public-bucket repo, so it is not the thing standing between an attacker and the disk.
  //
  // GET is deliberately NOT limited — the editor reads on every file-tree click and
  // every tab switch, and a read allocates nothing durable.
  const limited = rateLimit(`fs-write:${clientIp(req)}`, { capacity: 60, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many write requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const { op, path: relPath, to, type, content, contentBase64 } = body as {
    op: string; path: string; to?: string; type?: "file" | "dir"; content?: string; contentBase64?: string;
  };
  try {
    // Every branch below schedules a re-index AFTER the mutation returned and never in
    // the `catch`: a write that threw changed nothing, and re-indexing on failure would
    // burn a full pass to rediscover the tree we already have. The scheduler coalesces —
    // the editor autosaves about once a second and one index per save is a CPU storm on
    // a 0.5 vCPU container.
    if (op === "write") {
      writeWorkspaceFile(ws.dir, relPath, content ?? "");
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "upload") {
      if (typeof contentBase64 !== "string") return NextResponse.json({ error: "Missing contentBase64" }, { status: 400 });
      // F011: base64 is ~4/3 the size of the decoded bytes; cap the encoded
      // length first so we reject oversized payloads before the (cheaper
      // but still allocating) decode step.
      if (contentBase64.length > Math.ceil((MAX_WRITE_BYTES * 4) / 3)) {
        return NextResponse.json({ error: `File exceeds the ${MAX_WRITE_BYTES.toLocaleString()}-byte write limit` }, { status: 400 });
      }
      const bytes = Buffer.from(contentBase64, "base64");
      if (bytes.length > MAX_WRITE_BYTES) {
        return NextResponse.json({ error: `File exceeds the ${MAX_WRITE_BYTES.toLocaleString()}-byte write limit` }, { status: 400 });
      }
      writeWorkspaceBytes(ws.dir, relPath, bytes);
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "create") {
      createEntry(ws.dir, relPath, type === "dir" ? "dir" : "file");
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "rename" || op === "move") {
      if (!to) return NextResponse.json({ error: "Missing 'to'" }, { status: 400 });
      renameEntry(ws.dir, relPath, to);
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "duplicate") {
      if (!to) return NextResponse.json({ error: "Missing 'to'" }, { status: 400 });
      duplicateEntry(ws.dir, relPath, to);
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 400);
  }
}

// DELETE /api/repos/:id/fs?path=src/foo.ts  -> moves the entry to the repo's
// trash (restorable via /api/repos/:id/trash) instead of erasing it.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same bucket as POST, and deliberately so. A delete here is a MOVE into the repo's
  // trash on the same volume: it frees no bytes, it allocates a trash entry and a DB
  // row, and each one schedules a re-index. It is a write by every measure that matters
  // to the disk-exhaustion failure above, so it spends from the same budget.
  const limited = rateLimit(`fs-write:${clientIp(req)}`, { capacity: 60, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many write requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path");
  if (!relPath) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  try {
    const trash = moveToTrash(id, ws.dir, relPath);
    // A delete changes the graph as much as a write does — the symbol graph would keep
    // serving callers/callees for a file that is no longer there.
    scheduleReindex(id);
    return NextResponse.json({ ok: true, trash });
  } catch (e) {
    return err(e, 400);
  }
}
