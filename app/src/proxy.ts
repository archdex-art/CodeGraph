import { NextRequest, NextResponse } from "next/server";
import { checkBasicAuth } from "@/lib/basicAuth";

// Optional HTTP Basic Auth gate for the whole app. OFF by default — nothing
// changes unless you explicitly set CG_BASIC_AUTH_PASSWORD, so self-hosted/
// local-dev use is unaffected. Turn it on for a public deployment you don't
// want strangers browsing or indexing through. Username defaults to
// "codegraph"; override with CG_BASIC_AUTH_USER. /api/health always stays
// open so uptime monitors and the platform's own health checks keep working
// without credentials.
export function proxy(req: NextRequest) {
  const password = process.env.CG_BASIC_AUTH_PASSWORD;
  if (!password) return NextResponse.next();
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();

  const expectedUser = process.env.CG_BASIC_AUTH_USER || "codegraph";
  if (checkBasicAuth(req.headers.get("authorization"), expectedUser, password)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="CodeGraph"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
