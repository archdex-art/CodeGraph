import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { fetchGithubRepos } from "@/lib/githubOAuth";

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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to list GitHub repos" }, { status: 502 });
  }
}
