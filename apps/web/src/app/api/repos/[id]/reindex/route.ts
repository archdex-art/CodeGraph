import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import { reindexRepo } from "@/lib/store";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/repos/:id/reindex -> { jobId } | { alreadyRunning: true }
//
// Re-runs the pipeline over the repo's EXISTING workspace: no clone, no second repo
// row, no new repo id (AUDIT_2026-07-12 F098 — before this there was no way to refresh
// a repository short of deleting and re-creating it). The editor and the git route call
// it implicitly through `scheduleReindex`; this endpoint is the explicit "refresh now".
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Rate limited ABOVE the tenant check because authz is not protection here: a
  // public-bucket repo (`owner_id IS NULL`) is re-indexable by any anonymous visitor,
  // and `reindexRepo`'s busy check serialises per REPO only — N repos means N
  // concurrent CPU-bound index passes on a 512 MB / 0.5 vCPU box, and a single repo can
  // be re-indexed back to back forever. `/api/index` does strictly less work per call
  // (it may clone, but it also refuses a duplicate outright) and is capped at 10/min,
  // so 6/min per IP here is the same F015 budget scaled for the heavier work.
  const limited = rateLimit(`reindex:${clientIp(req)}`, { capacity: 6, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many re-index requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }

  // Same gate as every other workspace-touching route: the check and the workspace
  // resolution are one step so a handler cannot obtain a directory without having
  // passed the tenant check.
  //
  // `files: false` because re-indexing reads the repository out of git, not off disk. Letting
  // this materialise the working tree would reintroduce the 614 MB checkout at exactly the
  // moment the design exists to avoid it — and re-index is the one route guaranteed to run.
  const { denied } = requireWorkspace(req, id, { files: false });
  if (denied) return denied;

  const result = reindexRepo(id);
  if (result.ok) return NextResponse.json({ jobId: result.jobId }, { status: 202 });

  // A refused re-index is 200, not an error — the same reasoning as `/api/index`'s
  // `enqueued`. A run is already in flight for this repo (a double-click, two tabs, or
  // an autosave-triggered pass), which is the caller getting what it asked for slightly
  // earlier than it asked. `alreadyRunning` lets a client say so if it wants to.
  if (result.reason === "busy") return NextResponse.json({ alreadyRunning: true }, { status: 200 });

  // Reachable only by losing a race with a delete between `requireWorkspace` (which
  // 404s a missing workspace) and here. 409 rather than 404: the repo is visible to
  // this caller, it just has nothing on disk to re-index.
  return NextResponse.json({ error: "Workspace not ready" }, { status: 409 });
}
