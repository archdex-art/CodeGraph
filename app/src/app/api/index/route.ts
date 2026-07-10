import { NextRequest, NextResponse } from "next/server";
import { createIndexJob } from "@/lib/store";
import { localAccessAllowed, LOCAL_ACCESS_DISABLED_MESSAGE } from "@/lib/localAccess";
import { isPublicHttpUrl } from "@/lib/urlSafety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { repoUrl?: string; localPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const repoUrl = (body.repoUrl || "").trim();
  const localPath = (body.localPath || "").trim();

  try {
    if (localPath) {
      if (!localAccessAllowed()) {
        return NextResponse.json({ error: LOCAL_ACCESS_DISABLED_MESSAGE }, { status: 403 });
      }
      const { jobId, repoId } = createIndexJob(localPath, "local");
      return NextResponse.json({ jobId, repoId }, { status: 202 });
    }
    if (repoUrl) {
      if (!/^https?:\/\/[\w.-]+\/.+/.test(repoUrl) || !isPublicHttpUrl(repoUrl)) {
        return NextResponse.json(
          { error: "Provide a public https git URL (e.g. https://github.com/owner/repo) — loopback/private/link-local hosts are not allowed" },
          { status: 400 }
        );
      }
      const { jobId, repoId } = createIndexJob(repoUrl, "git");
      return NextResponse.json({ jobId, repoId }, { status: 202 });
    }
    return NextResponse.json({ error: "Provide repoUrl or localPath" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to start indexing";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
