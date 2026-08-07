import { NextRequest, NextResponse } from "next/server";
import { createIndexJob, type CreateIndexJobResult } from "@/lib/store";
import path from "node:path";
import {
  localAccessAllowed,
  withinLocalAccessRoot,
  LOCAL_ACCESS_DISABLED_MESSAGE,
  LOCAL_ACCESS_ROOT_MESSAGE,
} from "@/lib/localAccess";
import { isPublicHttpUrl } from "@codegraph/vcs";
import { getSession } from "@/lib/session";
import { anonymousIndexingAllowed, ANONYMOUS_INDEXING_MESSAGE } from "@/lib/authz";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shape the enqueue result into a response.
 *
 * A refused enqueue is `200`, not an error. The per-repo mutex rejects a second run
 * for a repository already being analysed, and that is an ordinary thing for a user to
 * do — a double-click, or two tabs. Returning 409 would make the UI render a failure
 * for something that is working; instead the caller gets the IN-FLIGHT job's id and
 * attaches to that progress stream. `alreadyRunning` distinguishes the two so a client
 * that wants to say so can.
 */
function enqueued(result: CreateIndexJobResult): NextResponse {
  if (!result.ok) {
    return NextResponse.json(
      { jobId: result.jobId, repoId: result.repoId, alreadyRunning: true },
      { status: 200 }
    );
  }
  return NextResponse.json({ jobId: result.jobId, repoId: result.repoId }, { status: 202 });
}

export async function POST(req: NextRequest) {
  // F015: each hit can trigger a real git clone (up to ~90s) or filesystem
  // walk, trivially repeatable by an anonymous visitor against the public
  // bucket for disk/CPU/bandwidth exhaustion.
  const limited = rateLimit(`index:${clientIp(req)}`, { capacity: 10, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many indexing requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }

  let body: { repoUrl?: string; localPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const repoUrl = (body.repoUrl || "").trim();
  const localPath = (body.localPath || "").trim();
  const session = getSession(req);

  // Before any work: a signed-out index would land in the shared public bucket.
  // 401 rather than 403 — the request is not forbidden, it is unauthenticated, and
  // signing in is exactly what fixes it.
  if (!session && !anonymousIndexingAllowed()) {
    return NextResponse.json({ error: ANONYMOUS_INDEXING_MESSAGE }, { status: 401 });
  }

  try {
    if (localPath) {
      if (!localAccessAllowed()) {
        return NextResponse.json({ error: LOCAL_ACCESS_DISABLED_MESSAGE }, { status: 403 });
      }
      // `/api/browse` refused a path outside CG_LOCAL_ACCESS_ROOT while this route indexed
      // it — and indexing is the stronger capability: it walks the tree and makes file
      // CONTENTS readable through the repo's fs/search/editor endpoints, where browse only
      // ever disclosed directory names. The containment root was therefore enforced on the
      // weaker of the two entry points.
      if (!withinLocalAccessRoot(path.resolve(localPath))) {
        return NextResponse.json({ error: LOCAL_ACCESS_ROOT_MESSAGE }, { status: 403 });
      }
      return enqueued(createIndexJob(localPath, "local", undefined, session?.userId ?? null));
    }
    if (repoUrl) {
      if (!/^https?:\/\/[\w.-]+\/.+/.test(repoUrl) || !isPublicHttpUrl(repoUrl)) {
        return NextResponse.json(
          { error: "Provide a public https git URL (e.g. https://github.com/owner/repo) — loopback/private/link-local hosts are not allowed" },
          { status: 400 }
        );
      }
      return enqueued(createIndexJob(repoUrl, "git", session?.accessToken, session?.userId ?? null));
    }
    return NextResponse.json({ error: "Provide repoUrl or localPath" }, { status: 400 });
  } catch (e) {
    // F023: internal fs/git/DB exception detail stays server-side.
    logger.warn("Failed to start indexing", { err: e });
    return NextResponse.json({ error: "Failed to start indexing" }, { status: 500 });
  }
}
