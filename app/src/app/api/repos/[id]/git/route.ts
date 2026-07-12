import { NextRequest, NextResponse } from "next/server";
import { getRepo, getWorkspaceDir, getSaveMode, setSaveMode } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";
import {
  isGitRepo,
  getStatus,
  listBranches,
  createBranch,
  checkoutBranch,
  pull,
  push,
  commit,
  diffFile,
  log,
  withToken,
} from "@/lib/gitops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function hasStderr(e: unknown): e is { stderr: string } {
  return typeof e === "object" && e !== null && "stderr" in e && typeof (e as Record<string, unknown>).stderr === "string";
}

function err(e: unknown, status = 500) {
  let msg = e instanceof Error ? e.message : String(e);
  if (hasStderr(e) && e.stderr.trim()) msg = e.stderr.trim();
  return NextResponse.json({ error: msg }, { status });
}

// GET /api/repos/:id/git?op=status|branches|log|diff&path=&limit=
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const ws = getWorkspaceDir(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
  if (!(await isGitRepo(ws.dir))) return NextResponse.json({ error: "Not a git workspace" }, { status: 409 });

  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") || "status";
  try {
    if (op === "status") return NextResponse.json(await getStatus(ws.dir));
    if (op === "branches") return NextResponse.json({ branches: await listBranches(ws.dir) });
    if (op === "log") return NextResponse.json({ entries: await log(ws.dir, Number(searchParams.get("limit")) || 30) });
    if (op === "diff") {
      const p = searchParams.get("path");
      if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });
      return NextResponse.json({ diff: await diffFile(ws.dir, p) });
    }
    if (op === "saveMode") return NextResponse.json({ saveMode: getSaveMode(id) });
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 500);
  }
}

// POST /api/repos/:id/git
// { op: "commit"|"push"|"pull"|"checkout"|"createBranch"|"setSaveMode", message?, name?, from?, githubToken?, saveMode? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const ws = getWorkspaceDir(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const { op, message, name, from, githubToken, saveMode } = body as {
    op: string; message?: string; name?: string; from?: string; githubToken?: string; saveMode?: string;
  };

  try {
    if (op === "setSaveMode") {
      if (saveMode !== "local" && saveMode !== "git-manual" && saveMode !== "git-auto") {
        return NextResponse.json({ error: "Invalid save mode" }, { status: 400 });
      }
      setSaveMode(id, saveMode);
      return NextResponse.json({ ok: true, saveMode });
    }

    if (!(await isGitRepo(ws.dir))) return NextResponse.json({ error: "Not a git workspace" }, { status: 409 });

    if (op === "commit") {
      if (!message?.trim()) return NextResponse.json({ error: "Commit message required" }, { status: 400 });
      await commit(ws.dir, message);
      return NextResponse.json({ ok: true });
    }
    if (op === "push") {
      const repo = getRepo(id);
      let remote: string | undefined;
      if (githubToken && repo?.sourceType === "git") remote = withToken(repo.url, githubToken);
      const out = await push(ws.dir, remote);
      return NextResponse.json({ ok: true, output: out });
    }
    if (op === "pull") {
      const out = await pull(ws.dir);
      return NextResponse.json({ ok: true, output: out });
    }
    if (op === "checkout") {
      if (!name) return NextResponse.json({ error: "Missing branch name" }, { status: 400 });
      await checkoutBranch(ws.dir, name);
      return NextResponse.json({ ok: true });
    }
    if (op === "createBranch") {
      if (!name) return NextResponse.json({ error: "Missing branch name" }, { status: 400 });
      await createBranch(ws.dir, name, from);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    // Surface raw git stderr (e.g. merge conflicts on pull, non-fast-forward on push)
    // so the UI can show the operator what happened instead of a generic 500.
    return err(e, 409);
  }
}
