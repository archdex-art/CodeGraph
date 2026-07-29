import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const denied = repoAccessDenied(req, job.repoId);
  if (denied) return denied;
  return NextResponse.json(job);
}
