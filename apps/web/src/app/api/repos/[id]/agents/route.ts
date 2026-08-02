import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/store";
import { repoAccessDenied, viewerId } from "@/lib/authz";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { runSwarm } from "@/lib/agents/orchestrator";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/agents -> RemediationPlan
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // runSwarm is fully synchronous CPU work on the request thread — it blocks
  // the event loop for every other request while it runs. Until it moves to a
  // worker, bound how often a single client can trigger it.
  const limited = rateLimit(`agents:${clientIp(req)}`, { capacity: 20, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many analysis requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }

  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "done") return NextResponse.json({ error: "Repo not indexed yet" }, { status: 409 });
  try {
    return NextResponse.json(runSwarm(repo));
  } catch (e) {
    logger.error("swarm failed", { err: e, route: "agents", repoId: id });
    return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
  }
}
