import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, fetchGithubUser, publicBaseUrl } from "@/lib/githubOAuth";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/github/callback?code=...&state=...
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get("cg_oauth_state")?.value;
  const returnTo = req.cookies.get("cg_oauth_return")?.value || "/";
  const base = publicBaseUrl(req.nextUrl.origin);

  if (!code || !state || !expectedState || state !== expectedState) {
    const res = NextResponse.redirect(
      new URL(`/?authError=${encodeURIComponent("Sign-in request expired or was tampered with. Please try again.")}`, base)
    );
    res.cookies.delete("cg_oauth_state");
    res.cookies.delete("cg_oauth_return");
    return res;
  }

  try {
    const redirectUri = new URL("/api/auth/github/callback", base).toString();
    const token = await exchangeCodeForToken(code, redirectUri);
    const user = await fetchGithubUser(token);

    const res = NextResponse.redirect(new URL(returnTo, base));
    setSessionCookie(res, {
      userId: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      accessToken: token,
      issuedAt: Date.now(),
    });
    res.cookies.delete("cg_oauth_state");
    res.cookies.delete("cg_oauth_return");
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GitHub sign-in failed";
    const res = NextResponse.redirect(new URL(`/?authError=${encodeURIComponent(msg)}`, base));
    res.cookies.delete("cg_oauth_state");
    res.cookies.delete("cg_oauth_return");
    return res;
  }
}
