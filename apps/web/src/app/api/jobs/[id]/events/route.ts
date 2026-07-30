import { NextRequest, NextResponse } from "next/server";
import { logger } from "@codegraph/observability";
import { repoAccessDenied } from "@/lib/authz";
import { getJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE progress for one job (PLAN.md §3).
 *
 * WHY POLL THE DATABASE RATHER THAN SUBSCRIBE. The progress writer is a different
 * PROCESS — `apps/worker` — so there is no in-process emitter to listen to, and the two
 * share only SQLite. A pub/sub channel between them would be a second coordination
 * mechanism beside the queue, with its own failure modes, to save a query that costs one
 * indexed primary-key lookup. HLD §11 already frames cancellation the same way: "a status
 * write the worker observes on heartbeat".
 *
 * What this buys over the client polling `/api/jobs/:id` itself is not fewer reads, it is
 * fewer ROUND TRIPS and a lower-latency finish: one connection instead of a request every
 * second, and terminal states arrive on the tick they happen rather than up to a poll
 * late. The client keeps working without it, which matters because SSE through a proxy is
 * not guaranteed.
 */

const TICK_MS = 500;
/**
 * Hard ceiling on one stream. Long enough for a real index on a slow host, short enough
 * that an abandoned connection cannot hold a Node handle open indefinitely — a browser
 * tab closed mid-index does not always deliver an abort promptly.
 */
const MAX_STREAM_MS = 15 * 60_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Authorised ONCE, before the stream opens, and never again inside it. The job's repo
  // cannot change owner mid-run, and re-checking per tick would put an authz query on a
  // twice-a-second loop for no added protection.
  const initial = getJob(id);
  if (!initial) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const denied = repoAccessDenied(req, initial.repoId);
  if (denied) return denied;

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let last = "";

      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting. Not an error.
        }
      };

      // Emit immediately so a client that connects to an already-finished job is told so
      // rather than waiting a tick for its first byte.
      send("progress", initial);
      last = JSON.stringify(initial);
      if (initial.status === "done" || initial.status === "error") {
        send("end", { status: initial.status });
        finish();
        return;
      }

      const timer = setInterval(() => {
        if (closed) return;

        if (Date.now() - started > MAX_STREAM_MS) {
          // Say why. A stream that just stops is indistinguishable from a dropped
          // connection, and the client should reconnect rather than assume failure.
          send("end", { status: "timeout" });
          finish();
          return;
        }

        const job = getJob(id);
        if (!job) {
          send("end", { status: "gone" });
          finish();
          return;
        }

        // Only write on change. An idle index would otherwise emit an identical frame
        // twice a second for minutes.
        const snapshot = JSON.stringify(job);
        if (snapshot !== last) {
          last = snapshot;
          send("progress", job);
        }

        if (job.status === "done" || job.status === "error") {
          send("end", { status: job.status });
          finish();
        }
      }, TICK_MS);

      // The client going away is the common case, not an exception: every completed index
      // ends with a navigation. Without this the interval keeps querying for a reader
      // that no longer exists.
      req.signal.addEventListener("abort", () => {
        logger.debug("SSE client disconnected", { jobId: id });
        finish();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      // `no-transform` matters as much as `no-cache`: a proxy that buffers to compress
      // defeats the point of streaming, and the symptom is progress arriving all at once
      // at the end.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx-family proxies buffer responses by default; this opts out.
      "X-Accel-Buffering": "no",
    },
  });
}
