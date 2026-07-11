import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { githubOAuthConfigured, buildAuthorizeUrl, publicBaseUrl } from "@/lib/githubOAuth";
import { oauthTransitCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/github?returnTo=/  -> redirect to GitHub's OAuth consent screen.
export async function GET(req: NextRequest) {
  if (!githubOAuthConfigured()) {
    return NextResponse.json(
      { error: "GitHub sign-in is not configured on this deployment (missing GITHUB_OAUTH_CLIENT_ID/SECRET or CG_SESSION_SECRET)." },
      { status: 501 }
    );
  }

  const state = randomBytes(16).toString("hex");
  const redirectUri = new URL("/api/auth/github/callback", publicBaseUrl(req.nextUrl.origin)).toString();
  const returnTo = req.nextUrl.searchParams.get("returnTo") || "/";

  const res = NextResponse.redirect(buildAuthorizeUrl(state, redirectUri));
  const opts = oauthTransitCookieOptions();
  res.cookies.set("cg_oauth_state", state, opts);
  res.cookies.set("cg_oauth_return", returnTo, opts);
  return res;
}
