import { NextRequest, NextResponse } from "next/server";
import { listRepos } from "@/lib/store";
import { viewerId } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return NextResponse.json({ repos: listRepos(viewerId(req)) });
}
