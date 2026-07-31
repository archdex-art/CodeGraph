import { NextResponse } from "next/server";
import { queueDepth, renderPrometheus, type GaugeSample } from "@codegraph/persistence";
import { contentCache } from "@codegraph/core-graph";

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
  /**
   * Gauges are sampled HERE rather than stored, because they describe what is true now. They
   * are also read here rather than inside `renderPrometheus` because their sources sit above
   * persistence in the layering - the content cache is `core-graph`, the depth is a query -
   * and reaching up for them would invert the dependency the layer rules protect.
   *
   * `cg_cache_hit_ratio` is per-process by construction: the cache is in-memory, so a scrape of
   * a multi-process deployment reports the process that answered. Documented rather than
   * papered over with an average that would belong to nobody.
   */
  const cache = contentCache.stats();
  const lookups = cache.hits + cache.misses;
  const gauges: GaugeSample[] = [
    // 0 rather than NaN before the first lookup: a ratio of nothing is not "unknown", it is
    // "nothing has been asked for yet", and a dashboard should not show a gap for that.
    { name: "cg_cache_hit_ratio", value: lookups === 0 ? 0 : cache.hits / lookups },
    { name: "cg_queue_depth", value: queueDepth() },
  ];

  return new NextResponse(renderPrometheus(gauges), {
    headers: {
      // The version suffix is part of the format contract; Prometheus checks it.
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
