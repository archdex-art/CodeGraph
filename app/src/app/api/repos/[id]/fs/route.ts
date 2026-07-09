import { NextResponse } from "next/server";
import { getWorkspaceDir } from "@/lib/store";
import {
  listDir,
  readWorkspaceFile,
  writeWorkspaceFile,
  createEntry,
  deleteEntry,
  renameEntry,
  duplicateEntry,
  resolveSafe,
  WorkspacePathError,
} from "@/lib/workspace";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workspaceOr404(id: string) {
  return getWorkspaceDir(id);
}

function err(e: unknown, fallback = 500) {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof WorkspacePathError ? 400 : fallback;
  return NextResponse.json({ error: msg }, { status });
}

// GET /api/repos/:id/fs?op=list&path=src         -> FsEntry[]
// GET /api/repos/:id/fs?op=read&path=src/index.ts -> { content, truncated, size, binary }
// GET /api/repos/:id/fs?op=download&path=a/b.png  -> raw file bytes (download)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = workspaceOr404(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") || "list";
  const relPath = searchParams.get("path") || ".";
  try {
    if (op === "list") return NextResponse.json({ entries: listDir(ws.dir, relPath) });
    if (op === "read") return NextResponse.json(readWorkspaceFile(ws.dir, relPath));
    if (op === "download") {
      const full = resolveSafe(ws.dir, relPath);
      const buf = readFileSync(full);
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(full)}"`,
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
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = workspaceOr404(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
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
          const full = resolveSafe(ws.dir, relPath);
          mkdirSync(path.dirname(full), { recursive: true });
          writeFileSync(full, Buffer.from(contentBase64, "base64"));
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

// DELETE /api/repos/:id/fs?path=src/foo.ts
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = workspaceOr404(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path");
  if (!relPath) return NextResponse.json({ error: "Missing path" }, { status: 400 });
  try {
    deleteEntry(ws.dir, relPath);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return err(e, 400);
  }
}
