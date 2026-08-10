import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { fetchGithubRepos } from "@/lib/githubOAuth";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/github/repos?page=1 -> { repos, page, hasMore } for the signed-in user.
export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  try {
    const { repos, hasMore } = await fetchGithubRepos(session.accessToken, page);
    return NextResponse.json({ repos, page, hasMore });
  } catch (e) {
    // `fetchGithubRepos` throws its own controlled string, but a transport failure does not:
    // undici surfaces `fetch failed` with a cause carrying host, port and TLS detail, and any
    // future body-derived message would carry whatever GitHub said. Neither belongs on the
    // wire, and the client can act on exactly one thing — retry or re-authenticate.
    logger.warn("GitHub repo list failed", { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { error: "Could not list your GitHub repositories. Sign in again, or retry in a moment." },
      { status: 502 },
    );
  }
}
