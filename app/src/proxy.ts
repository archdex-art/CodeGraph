import { NextRequest, NextResponse } from "next/server";
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

  const password = process.env.CG_BASIC_AUTH_PASSWORD;
  if (password) {
    const expectedUser = process.env.CG_BASIC_AUTH_USER || "codegraph";
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
        "<!doctype html><html><body style=\"font-family:system-ui;background:#050505;color:#e5e5e5;" +
          "display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">" +
          "<div style=\"text-align:center\"><h1>Access Restricted</h1>" +
          "<p>This CodeGraph instance is private to its owner's GitHub account.</p></div></body></html>",
        { status: 403, headers: { "Content-Type": "text/html" } },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
