import { NextRequest, NextResponse } from "next/server";
import { createIndexJob } from "@/lib/store";
import { localAccessAllowed, LOCAL_ACCESS_DISABLED_MESSAGE } from "@/lib/localAccess";
import { isPublicHttpUrl } from "@/lib/urlSafety";
import { getSession } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    if (localPath) {
      if (!localAccessAllowed()) {
        return NextResponse.json({ error: LOCAL_ACCESS_DISABLED_MESSAGE }, { status: 403 });
      }
      const { jobId, repoId } = createIndexJob(localPath, "local", undefined, session?.userId ?? null);
      return NextResponse.json({ jobId, repoId }, { status: 202 });
    }
    if (repoUrl) {
      if (!/^https?:\/\/[\w.-]+\/.+/.test(repoUrl) || !isPublicHttpUrl(repoUrl)) {
        return NextResponse.json(
          { error: "Provide a public https git URL (e.g. https://github.com/owner/repo) — loopback/private/link-local hosts are not allowed" },
          { status: 400 }
        );
      }
      const { jobId, repoId } = createIndexJob(repoUrl, "git", session?.accessToken, session?.userId ?? null);
      return NextResponse.json({ jobId, repoId }, { status: 202 });
    }
    return NextResponse.json({ error: "Provide repoUrl or localPath" }, { status: 400 });
  } catch (e) {
    // F023: internal fs/git/DB exception detail stays server-side.
    console.warn("Failed to start indexing:", e);
    return NextResponse.json({ error: "Failed to start indexing" }, { status: 500 });
  }
}
