import { NextRequest, NextResponse } from "next/server";
// Aliased: this module already exports its own `config` (Next's proxy matcher).
import { config as appConfig } from "@codegraph/config";
import { checkBasicAuth } from "@/lib/basicAuth";
import { githubOAuthConfigured, isAllowedOwnerLogin, ownerLoginAllowlist } from "@/lib/githubOAuth";
import { getSession } from "@/lib/session";

// Node.js runtime is guaranteed for proxy.ts by Next.js itself (that's the
// whole point of the proxy.ts convention replacing middleware.ts) -- no
// `export const runtime` needed/allowed here, unlike edge-runtime middleware.

// Routes that must stay reachable even when the owner-lock below is active,
// so the OAuth sign-in flow itself never gets blocked by the check it's
// trying to satisfy, and platform health checks keep working.
const ALWAYS_OPEN = new Set([
  "/api/health",
  "/api/auth/github",
  "/api/auth/github/callback",
  "/api/auth/logout",
]);

// Optional HTTP Basic Auth gate for the whole app. OFF by default — nothing
// changes unless you explicitly set CG_BASIC_AUTH_PASSWORD, so self-hosted/
// local-dev use is unaffected. Turn it on for a public deployment you don't
// want strangers browsing or indexing through. Username defaults to
// "codegraph"; override with CG_BASIC_AUTH_USER. /api/health always stays
// open so uptime monitors and the platform's own health checks keep working
// without credentials.
//
// Optional GitHub-account owner-lock: set CG_OWNER_GITHUB_LOGIN (one login,
// or a comma-separated list) to restrict the ENTIRE app -- pages and every
// API route, including the normally-anonymous "public bucket" -- to signed-
// in GitHub accounts on that allowlist. Anyone else gets bounced to sign-in
// (if unauthenticated) or a static "Access Restricted" response (if signed
// in as a different account) — never a redirect loop.
export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (pathname === "/api/health") return NextResponse.next();

  const password = appConfig.basicAuthPassword;
  if (password) {
    const expectedUser = appConfig.basicAuthUser;
    if (!checkBasicAuth(req.headers.get("authorization"), expectedUser, password)) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="CodeGraph"' },
      });
    }
  }

  const allowlist = ownerLoginAllowlist();
  if (allowlist && !ALWAYS_OPEN.has(pathname)) {
    if (!githubOAuthConfigured()) {
      return new NextResponse(
        "CG_OWNER_GITHUB_LOGIN is set but GitHub OAuth is not fully configured " +
          "(GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET / CG_SESSION_SECRET) — failing closed.",
        { status: 500 },
      );
    }
    const session = getSession(req);
    const isApi = pathname.startsWith("/api/");

    if (!session) {
      if (isApi) return NextResponse.json({ error: "Sign in with GitHub to use this deployment." }, { status: 401 });
      const returnTo = encodeURIComponent(pathname + req.nextUrl.search);
      return NextResponse.redirect(new URL(`/api/auth/github?returnTo=${returnTo}`, req.url));
    }
    if (!isAllowedOwnerLogin(session.login)) {
      if (isApi) return NextResponse.json({ error: "This deployment is private to its owner." }, { status: 403 });
      return new NextResponse(
        // Inline, self-contained HTML: this runs in middleware, before any React or
        // stylesheet exists, so the tokens have to be literals. Kept in step with
        // globals.css by hand — for a gated visitor this is the FIRST and possibly only
        // screen they ever see, and the old palette here made it look like a different
        // product's error page.
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          "<title>CodeGraph — access restricted</title></head>" +
          '<body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#06080a;color:#e8edf2;' +
          'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">' +
          '<div style="text-align:center;max-width:26rem">' +
          '<div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.18em;' +
          'text-transform:uppercase;color:#707e8b;margin-bottom:14px">Access restricted</div>' +
          '<h1 style="font-size:1.6rem;font-weight:400;margin:0 0 12px;letter-spacing:-.02em">' +
          'This instance is <em style="color:#c6f24e">private</em>.</h1>' +
          '<p style="color:#93a1ae;line-height:1.6;margin:0;font-size:14px">' +
          "This CodeGraph deployment is restricted to its owner&rsquo;s GitHub account.</p>" +
          "</div></body></html>",
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
