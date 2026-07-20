import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceDir } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";
import { TimelineEngine, Strategies } from "@/lib/gitops/timelineApi";
import { loadSnapshotCache } from "@/lib/gitops/timelineStore";
import { isGitRepo } from "@/lib/gitops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(e: unknown, status = 500) {
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status });
}

// GET /api/repos/:id/timeline?op=metadata|trends|snapshot|compare
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;

  const ws = getWorkspaceDir(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });
  if (!(await isGitRepo(ws.dir))) return NextResponse.json({ error: "Not a git workspace" }, { status: 409 });

  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") || "metadata";
  const strategy = (searchParams.get("strategy") || "monthly") as keyof typeof Strategies;

  const engine = new TimelineEngine(id, ws.dir);

  try {
    if (op === "metadata") {
      const timeline = await engine.getTimeline(strategy);
      return NextResponse.json({ timeline });
    }

    if (op === "trends") {
      const trends = await engine.getMetricTrends();
      return NextResponse.json({ trends });
    }

    if (op === "snapshot") {
      const hash = searchParams.get("hash");
      if (!hash) return NextResponse.json({ error: "Missing hash" }, { status: 400 });
      
      // ensureSnapshot generates and caches the graph if it doesn't exist
      await engine.ensureSnapshot(hash);
      const snapshot = await loadSnapshotCache(id, hash);
      return NextResponse.json({ snapshot });
    }

    if (op === "compare") {
      const base = searchParams.get("base");
      const head = searchParams.get("head");
      if (!base || !head) return NextResponse.json({ error: "Missing base or head hash" }, { status: 400 });

      await engine.ensureSnapshot(base);
      await engine.ensureSnapshot(head);
      const controller = await engine.getController();
      const evolution = await controller.compare(base, head);
      
      if (!evolution) {
        return NextResponse.json({ error: "One or both snapshots are not cached. Call snapshot first." }, { status: 404 });
      }
      return NextResponse.json({ evolution });
    }

    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 500);
  }
}

// POST /api/repos/:id/timeline
// { op: "build", strategy?: "monthly" }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;

  const ws = getWorkspaceDir(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const op = body.op;
  const strategy = (body.strategy || "monthly") as keyof typeof Strategies;

  const engine = new TimelineEngine(id, ws.dir);

  try {
    if (op === "build") {
      // Fire-and-forget or await depending on size, but for a potentially 
      // large timeline, we await it here and let Vercel/Node stream it or handle long-running timeouts.
      // In a heavy production system this would dispatch to a worker.
      await engine.buildTimeline(strategy);
      return NextResponse.json({ ok: true, message: "Timeline build completed." });
    }

    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    return err(e, 500);
  }
}
