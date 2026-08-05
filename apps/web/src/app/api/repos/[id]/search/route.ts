import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import { searchWorkspace } from "@codegraph/fsx";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/search?q=needle -> { results: SearchMatch[] }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // `searchWorkspace` is SYNCHRONOUS: it recursively walks up to 6000 files, buffering
  // and lowercasing each one, so the whole call blocks the single Node event loop —
  // every other request on the instance, including the health check, stalls behind it.
  // This is NOT a ReDoS concern: `q` reaches `String.includes`, never a compiled regex.
  // It is plain event-loop starvation, so the cap is on call RATE, not query shape.
  // Limited above the tenant check for the same reason as reindex: public-bucket repos
  // make the gate a no-op for an anonymous caller.
  const limited = rateLimit(`search:${clientIp(req)}`, { capacity: 30, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many search requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") || "";
  const results = searchWorkspace(ws.dir, q, 200);
  return NextResponse.json({ results });
}
