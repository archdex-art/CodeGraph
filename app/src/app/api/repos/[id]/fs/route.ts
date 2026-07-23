import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import {
  listDir,
  readWorkspaceFile,
  writeWorkspaceFile,
  createEntry,
  renameEntry,
  duplicateEntry,
  resolveSafe,
  WorkspacePathError,
  MAX_WRITE_BYTES,
} from "@/lib/workspace";
import { moveToTrash } from "@/lib/trash";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

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
  console.warn("fs route error:", e instanceof Error ? e.message : String(e));
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
      const full = resolveSafe(ws.dir, relPath);
      const buf = readFileSync(full);
      const name = path.basename(full);
      // A filename with `"`, `\`, or non-ASCII bytes corrupts a quoted
      // Content-Disposition header (Next.js rejects it -> 500, and raw CR/LF
      // would enable header injection). Emit an ASCII-sanitized fallback plus
      // an RFC 5987 UTF-8 encoded `filename*` for correct clients.
      const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      return new NextResponse(new Uint8Array(buf), {
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
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const { op, path: relPath, to, type, content, contentBase64 } = body as {
    op: string; path: string; to?: string; type?: "file" | "dir"; content?: string; contentBase64?: string;
  };
  try {
    if (op === "write") {
      writeWorkspaceFile(ws.dir, relPath, content ?? "");
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
      const full = resolveSafe(ws.dir, relPath);
      const bytes = Buffer.from(contentBase64, "base64");
      if (bytes.length > MAX_WRITE_BYTES) {
        return NextResponse.json({ error: `File exceeds the ${MAX_WRITE_BYTES.toLocaleString()}-byte write limit` }, { status: 400 });
      }
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, bytes);
      return NextResponse.json({ ok: true });
    }
    if (op === "create") {
      createEntry(ws.dir, relPath, type === "dir" ? "dir" : "file");
      return NextResponse.json({ ok: true });
    }
    if (op === "rename" || op === "move") {
      if (!to) return NextResponse.json({ error: "Missing 'to'" }, { status: 400 });
      renameEntry(ws.dir, relPath, to);
      return NextResponse.json({ ok: true });
    }
    if (op === "duplicate") {
      if (!to) return NextResponse.json({ error: "Missing 'to'" }, { status: 400 });
      duplicateEntry(ws.dir, relPath, to);
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
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path");
  if (!relPath) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  try {
    const trash = moveToTrash(id, ws.dir, relPath);
    return NextResponse.json({ ok: true, trash });
  } catch (e) {
    return err(e, 400);
  }
}
