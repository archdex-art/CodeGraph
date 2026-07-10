import { localAccessAllowed } from "@/lib/localAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", uptime: process.uptime(), ts: Date.now(), localAccessAllowed: localAccessAllowed() },
    { status: 200 }
  );
}
