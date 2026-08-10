import { NextRequest, NextResponse } from "next/server";
import { logger } from "@codegraph/observability";
import { config } from "@codegraph/config";
import { repoAccessDenied } from "@/lib/authz";
import { clientIp } from "@/lib/rateLimit";
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
/**
 * Concurrently open streams, globally and per client.
 *
 * Each one holds a Node handle and a twice-a-second SQLite read for up to fifteen minutes,
 * and nothing bounded how many a single client could open. Refusing past the ceiling is safe
 * to do bluntly because the client already falls back to polling `/api/jobs/:id` when the
 * stream is unavailable — SSE through a proxy was never guaranteed, so the fallback exists
 * and is exercised.
 *
 * Module-level state, which is correct here and not a coincidence: the thing being counted is
 * connections held open by THIS process, so a per-process counter is exactly the scope of the
 * resource. Nothing to coordinate across instances.
 */
const openStreams = { total: 0, byIp: new Map<string, number>() };

function acquireStream(ip: string): boolean {
  if (openStreams.total >= config.maxEventStreams) return false;
  const forIp = openStreams.byIp.get(ip) ?? 0;
  if (forIp >= config.maxEventStreamsPerIp) return false;
  openStreams.total++;
  openStreams.byIp.set(ip, forIp + 1);
  return true;
}

function releaseStream(ip: string): void {
  openStreams.total = Math.max(0, openStreams.total - 1);
  const forIp = (openStreams.byIp.get(ip) ?? 1) - 1;
  // Delete rather than keep a zero: the map is keyed by client IP and would otherwise grow
  // once per distinct visitor for the life of the process.
  if (forIp <= 0) openStreams.byIp.delete(ip);
  else openStreams.byIp.set(ip, forIp);
}

/** Test seam — a module-level counter outlives a test file otherwise. */
export function resetEventStreamsForTests(): void {
  openStreams.total = 0;
  openStreams.byIp.clear();
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Authorised ONCE, before the stream opens, and never again inside it. The job's repo
  // cannot change owner mid-run, and re-checking per tick would put an authz query on a
  // twice-a-second loop for no added protection.
  const initial = getJob(id);
  if (!initial) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const denied = repoAccessDenied(req, initial.repoId);
  if (denied) return denied;

  // Taken AFTER the access check so a refused stream cannot be used to probe job ids, and
  // released by `finish()` on every exit path below.
  const ip = clientIp(req);
  if (!acquireStream(ip)) {
    logger.warn("SSE stream refused: at capacity", { jobId: id, open: openStreams.total });
    return NextResponse.json(
      { error: "Too many open progress streams. The client falls back to polling." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let last = "";
      /**
       * Declared before `finish`, not by it. `finish()` runs on the already-finished-job
       * path BELOW — before `setInterval` has been reached — and a `const timer` declared
       * after it is in its temporal dead zone there, so `clearInterval(timer)` threw
       * `ReferenceError: Cannot access 'timer' before initialization` inside `start()`.
       * The stream errored instead of delivering the terminal event, so a client attaching
       * to a job that had ALREADY completed — the common case for a fast index, or any
       * reconnect — got a broken stream rather than "done".
       */
      let timer: ReturnType<typeof setInterval> | undefined;

      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        // Every exit runs through here — timeout, terminal status, vanished job, client
        // disconnect — which is why the slot is released here and nowhere else.
        releaseStream(ip);
        if (timer !== undefined) clearInterval(timer);
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

      timer = setInterval(() => {
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
