import { NextResponse } from "next/server";
import { renderPrometheus } from "@codegraph/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics — Prometheus text exposition (HLD §14, LLD §9.2).
 *
 * DELIBERATELY UNAUTHENTICATED, matching `/api/health`, and the reasoning is the same: a
 * scrape has to work before anything is configured, and the app's own Basic Auth gate
 * (`proxy.ts`) exempts health for exactly that reason. What is exposed is counts — gate
 * outcomes, run outcomes — with no repository names, URLs, paths, or finding text. An operator
 * who needs it private puts it behind their own ingress, which is where that decision belongs
 * for a self-hosted container.
 *
 * If a future counter carries a label with user data, THAT is the change that needs a gate
 * here, not this endpoint existing.
 */
export function GET() {
  return new NextResponse(renderPrometheus(), {
    headers: {
      // The version suffix is part of the format contract; Prometheus checks it.
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
