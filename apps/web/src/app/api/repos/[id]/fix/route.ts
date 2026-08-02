import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/store";
import { repoAccessDenied, viewerId } from "@/lib/authz";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { executeFixes } from "@/lib/agents/executor";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/repos/:id/fix -> FixResult (verified remediation patch + PR draft)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // This route clones a repository and runs TWO full index passes on the
  // request thread. It is the single most expensive endpoint in the app and
  // was the only expensive one with no limiter.
  const limited = rateLimit(`fix:${clientIp(req)}`, { capacity: 3, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many remediation requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
    );
  }

  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "done") return NextResponse.json({ error: "Repo not indexed yet" }, { status: 409 });

  try {
    const result = await executeFixes(repo);
    return NextResponse.json(result);
  } catch (e) {
    // Never echo the raw exception: executor failures can embed clone paths and
    // remote URLs. Log the detail, return a stable message.
    logger.error("executor failed", { err: e, route: "fix", repoId: id });
    return NextResponse.json({ error: "Remediation failed" }, { status: 500 });
  }
}
