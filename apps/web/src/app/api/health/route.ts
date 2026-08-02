import { localAccessAllowed } from "@/lib/localAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// F019: this endpoint is intentionally unauthenticated (exempted from Basic
// Auth / owner-lock in proxy.ts so uptime monitors and platform health
// checks keep working without credentials). `localAccessAllowed` is kept —
// unlike a pure diagnostic field, the landing page (`app/page.tsx`) reads it
// to pre-emptively disable the "Local folder" indexing button, a real UX
// dependency the audit finding didn't account for — dropping it would leave
// the button stuck enabled until a 403 on submit. `uptime` had no such use
// (see `lib/api.ts`'s `HealthStatus` type, which never declared it) and is
// dropped: pure unauthenticated reconnaissance with zero legitimate client
// consumer.
export function GET() {
  return Response.json({ status: "ok", localAccessAllowed: localAccessAllowed() }, { status: 200 });
}
