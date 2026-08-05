import { NextRequest, NextResponse } from "next/server";
import { getRepo, getSaveMode, setSaveMode, scheduleReindex } from "@/lib/store";
import { requireWorkspace, viewerId } from "@/lib/authz";
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
  diffCommitsFile,
  getCommitDiffFiles,
  restoreFile,
  log,
  withToken,
  isGithubHost,
} from "@codegraph/vcs";
import { redactCredentials } from "@codegraph/vcs";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function hasStderr(e: unknown): e is { stderr: string } {
  return typeof e === "object" && e !== null && "stderr" in e && typeof (e as Record<string, unknown>).stderr === "string";
}

// Ops whose git stderr IS the actionable product signal, and the only ones that forward
// it: a merge conflict on `pull`, a non-fast-forward or auth rejection on `push`, an
// empty index or a rejecting pre-commit hook on `commit`. For these, git's own words are
// the product — a generic string makes the failure unactionable and the operator has no
// other channel to the working tree.
//
// Everything else is narrowed (F023). `err` is the catch-all for BOTH handlers and every
// op, so it was also forwarding raw execFile output for status/branches/log/diff/
// checkout/createBranch/restore — output that embeds the server's absolute workspace path
// (/app/data/workspaces/<uuid>/...), exactly the disclosure the fs and trash routes beside
// it suppress. It was also the delivery channel for the argv injection into `git checkout`
// (fixed in packages/vcs/src/git.ts): the attacker read the target file back out of this
// error body. Those ops now log server-side and return a generic message.
const STDERR_OPS = new Set(["push", "pull", "commit"]);

function err(e: unknown, status: number, op: string) {
  const raw = hasStderr(e) && e.stderr.trim() ? e.stderr.trim() : e instanceof Error ? e.message : String(e);
  if (!STDERR_OPS.has(op)) {
    // Redacted in the LOG too, not just on the wire: these ops take no token today, but
    // the log ships to Render's stdout and a future token-bearing op must not regress
    // a PAT into it just because this branch stopped being the client-facing one.
    logger.warn("git route error", { op, error: redactCredentials(raw) });
    return NextResponse.json({ error: "Git operation failed" }, { status });
  }
  // A failed push embeds the token-bearing remote URL
  // (https://x-access-token:<PAT>@github.com/...) in execFile's error message
  // and stderr; strip it before it reaches the client (matches F004/F017).
  return NextResponse.json({ error: redactCredentials(raw) }, { status });
}

// GET /api/repos/:id/git?op=status|branches|log|diff&path=&limit=
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
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
    if (op === "diffFiles") {
      const base = searchParams.get("base");
      const head = searchParams.get("head");
      if (!base || !head) return NextResponse.json({ error: "Missing base or head" }, { status: 400 });
      return NextResponse.json({ files: await getCommitDiffFiles(ws.dir, base, head) });
    }
    if (op === "diffCommits") {
      const base = searchParams.get("base");
      const head = searchParams.get("head");
      const p = searchParams.get("path");
      if (!base || !head || !p) return NextResponse.json({ error: "Missing base, head, or path" }, { status: 400 });
      return NextResponse.json({ diff: await diffCommitsFile(ws.dir, base, head, p) });
    }
    if (op === "saveMode") return NextResponse.json({ saveMode: getSaveMode(id) });
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 500, op);
  }
}

// POST /api/repos/:id/git
// { op: "commit"|"push"|"pull"|"checkout"|"createBranch"|"setSaveMode", message?, name?, from?, githubToken?, saveMode? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;

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

    // AUDIT_2026-07-12.md:934 (F098). None of these four handlers used to trigger
    // anything, so after a commit/pull/checkout through the built-in editor
    // `/api/repos/[id]/intel` kept serving the pre-mutation symbol graph indefinitely.
    // Each one changes what is on disk — a checkout can replace the entire tree — so
    // each schedules a re-index, after the git command succeeded and never in the
    // `catch`, where the workspace is by definition unchanged.
    //
    // `push` is deliberately absent: it moves bytes to a remote and leaves the working
    // tree exactly as it was. `restore` is absent for a narrower reason — it reverts one
    // file to HEAD, which IS a content change, but it is reachable only from the diff
    // view's discard action and the next autosave in that file re-triggers anyway.
    if (op === "commit") {
      if (!message?.trim()) return NextResponse.json({ error: "Commit message required" }, { status: 400 });
      await commit(ws.dir, message);
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "push") {
      const repo = getRepo(id, viewerId(req));
      if (githubToken && repo?.sourceType === "git" && !isGithubHost(repo.url)) {
        return NextResponse.json(
          { error: "A GitHub PAT can only be used to push to a github.com-hosted repo." },
          { status: 400 }
        );
      }
      const remote = githubToken && repo?.sourceType === "git" ? withToken(repo.url, githubToken) : undefined;
      const out = await push(ws.dir, remote);
      return NextResponse.json({ ok: true, output: out });
    }
    if (op === "pull") {
      const out = await pull(ws.dir);
      scheduleReindex(id);
      return NextResponse.json({ ok: true, output: out });
    }
    if (op === "checkout") {
      if (!name) return NextResponse.json({ error: "Missing branch name" }, { status: 400 });
      await checkoutBranch(ws.dir, name);
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "createBranch") {
      if (!name) return NextResponse.json({ error: "Missing branch name" }, { status: 400 });
      await createBranch(ws.dir, name, from);
      scheduleReindex(id);
      return NextResponse.json({ ok: true });
    }
    if (op === "restore") {
      const p = body.path as string | undefined;
      if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });
      await restoreFile(ws.dir, p);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    // Forwards raw git stderr only for push/pull/commit (see `err`) — a merge conflict
    // or a non-fast-forward is something the operator must read verbatim. The remaining
    // ops get a generic 409 so an fs-level error cannot disclose the workspace path.
    return err(e, 409, op);
  }
}
