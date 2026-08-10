import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import { TimelineEngine, Strategies } from "@/lib/gitops/timelineApi";
import { loadSnapshotCache } from "@/lib/gitops/timelineStore";
import { isGitRepo } from "@codegraph/vcs";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Never echo the raw exception (CLAUDE.md standing rule, F023): this route drives `git
// archive`/`git log` inside the workspace, so a failure message carries git's stderr and the
// server's absolute workspace path (/app/data/workspaces/<uuid>/…). The fs, trash and git
// routes beside it already narrow; this one forwarded everything.
function err(e: unknown, status = 500) {
  logger.warn("timeline route error", { error: e instanceof Error ? e.message : String(e) });
  return NextResponse.json({ error: "Timeline operation failed" }, { status });
}

/** 400, not a 500, for a hash that is not a git object name. */
function badHash(): NextResponse {
  return NextResponse.json({ error: "Invalid commit hash" }, { status: 400 });
}

/**
 * A commit hash from the client becomes a FILENAME in the snapshot cache
 * (`data/timeline/<repo>/<hash>.json`) and an argument to `git archive`. Anything that is
 * not a hash has no business doing either, so it is rejected before it reaches the engine
 * rather than sanitised somewhere downstream.
 */
const HASH = /^[0-9a-f]{7,40}$/;
function isCommitHash(value: string | null): value is string {
  return value !== null && HASH.test(value);
}

// GET /api/repos/:id/timeline?op=metadata|trends|points|snapshot|compare|delta
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
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

    if (op === "points") {
      // Cache-only: the structural series plot whatever is already indexed. No build.
      const points = await engine.getTrendPoints();
      return NextResponse.json({ points });
    }

    if (op === "snapshot") {
      const hash = searchParams.get("hash");
      if (!hash) return NextResponse.json({ error: "Missing hash" }, { status: 400 });
      if (!isCommitHash(hash)) return badHash();
      
      // ensureSnapshot generates and caches the graph if it doesn't exist
      await engine.ensureSnapshot(hash);
      const snapshot = await loadSnapshotCache(id, hash);
      return NextResponse.json({ snapshot });
    }

    if (op === "compare" || op === "delta") {
      const base = searchParams.get("base");
      const head = searchParams.get("head");
      if (!base || !head) return NextResponse.json({ error: "Missing base or head hash" }, { status: 400 });
      if (!isCommitHash(base) || !isCommitHash(head)) return badHash();

      // `delta` is the one-click "what changed since last index" path: both sides are
      // already cached by definition, so it never spends minutes building one.
      if (op === "compare") {
        await engine.ensureSnapshot(base);
        await engine.ensureSnapshot(head);
      }

      const delta = await engine.getSnapshotDelta(base, head);
      if (!delta) {
        return NextResponse.json({ error: "One or both snapshots are not cached. Call snapshot first." }, { status: 404 });
      }

      // Both sides are cached (the delta above proves it), so `compare` reads the same two
      // files rather than building anything — the evolution narrative comes free either way.
      const controller = await engine.getController();
      const evolution = await controller.compare(base, head);
      return NextResponse.json({ evolution, delta });
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
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;

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
