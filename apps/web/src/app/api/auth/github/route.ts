import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { githubOAuthConfigured, buildAuthorizeUrl, publicBaseUrl, PUBLIC_URL_UNKNOWN_MESSAGE } from "@/lib/githubOAuth";
import { isSafeReturnPath } from "@codegraph/vcs";
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

  // Refuse here rather than bounce the visitor to GitHub with a redirect_uri that
  // cannot match: the error there names GitHub, not the variable that is unset.
  const base = publicBaseUrl(req);
  if (!base) {
    return NextResponse.redirect(
      new URL(`/?authError=${encodeURIComponent(PUBLIC_URL_UNKNOWN_MESSAGE)}`, req.url)
    );
  }

  const state = randomBytes(16).toString("hex");
  const redirectUri = new URL("/api/auth/github/callback", base).toString();
  const rawReturnTo = req.nextUrl.searchParams.get("returnTo") || "/";
  const returnTo = isSafeReturnPath(rawReturnTo) ? rawReturnTo : "/";

  const res = NextResponse.redirect(buildAuthorizeUrl(state, redirectUri));
  const opts = oauthTransitCookieOptions(req);
  res.cookies.set("cg_oauth_state", state, opts);
  res.cookies.set("cg_oauth_return", returnTo, opts);
  return res;
}
