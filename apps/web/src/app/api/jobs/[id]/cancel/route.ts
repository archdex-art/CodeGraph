import { NextRequest, NextResponse } from "next/server";
import { createJobQueue } from "@codegraph/jobs";
import { repoAccessDenied } from "@/lib/authz";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { getJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Request cancellation of a job (PLAN.md §3).
 *
 * COOPERATIVE, AND THE RESPONSE SAYS SO. This writes `cancelled` to the row; the worker
 * notices at its next heartbeat and SIGTERMs the executor, escalating to SIGKILL after a
 * grace period. So cancellation is a REQUEST, not a guarantee of immediate stop — there is
 * no way to interrupt a synchronous parse mid-file, and the honest interface is one that
 * returns `cancelling` rather than implying the work has already ended.
 *
 * Already-terminal jobs return 409 rather than pretending to cancel. `cancelJob` refuses
 * to rewrite a succeeded job into a cancellation, and the route must not report otherwise.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Cheap for the server but it kills real work, so it is rate-limited like any other
  // state change an anonymous visitor can reach.
  const limited = rateLimit(`cancel:${clientIp(req)}`, { capacity: 30, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many cancellation requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Tenant check before the write, so a non-owner cannot cancel someone else's index.
  const denied = repoAccessDenied(req, job.repoId);
  if (denied) return denied;

  if (!createJobQueue().cancel(id)) {
    return NextResponse.json(
      { error: "Job has already finished", status: job.status },
      { status: 409 }
    );
  }

  // 202, not 200: the request is accepted and the work is still winding down.
  return NextResponse.json({ jobId: id, status: "cancelling" }, { status: 202 });
}
