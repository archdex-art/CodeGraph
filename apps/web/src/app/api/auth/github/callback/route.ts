import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, fetchGithubUser, publicBaseUrl } from "@/lib/githubOAuth";
import { setSessionCookie } from "@/lib/session";
import { timingSafeEqual } from "@/lib/basicAuth";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/github/callback?code=...&state=...
export async function GET(req: NextRequest) {
  // F015: this route burns the app's own GitHub OAuth quota on every hit
  // and is unauthenticated by definition (it's the sign-in flow itself).
  const limited = rateLimit(`oauth-callback:${clientIp(req)}`, { capacity: 10, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many sign-in attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get("cg_oauth_state")?.value;
  const returnTo = req.cookies.get("cg_oauth_return")?.value || "/";
  const base = publicBaseUrl(req.nextUrl.origin);

  // F022: constant-time compare for consistency with basicAuth.ts's own
  // stated security posture for this class of secret comparison.
  const stateOk = !!state && !!expectedState && timingSafeEqual(state, expectedState);
  if (!code || !stateOk) {
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
    }, req);
    res.cookies.delete("cg_oauth_state");
    res.cookies.delete("cg_oauth_return");
    return res;
  } catch (e) {
    // F023: GitHub API/network exception detail stays server-side; the
    // client only ever sees a generic message.
    console.warn("GitHub OAuth callback failed:", e);
    const res = NextResponse.redirect(new URL(`/?authError=${encodeURIComponent("GitHub sign-in failed. Please try again.")}`, base));
    res.cookies.delete("cg_oauth_state");
    res.cookies.delete("cg_oauth_return");
    return res;
  }
}
