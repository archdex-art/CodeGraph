import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { githubOAuthConfigured } from "@/lib/githubOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/me -> { githubAuthEnabled, user } — never returns the raw
// access token, only what the UI needs to render a signed-in state.
export async function GET(req: NextRequest) {
  const session = getSession(req);
  return NextResponse.json({
    githubAuthEnabled: githubOAuthConfigured(),
    user: session ? { login: session.login, name: session.name, avatarUrl: session.avatarUrl } : null,
  });
}
