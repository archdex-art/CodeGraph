import { NextResponse } from "next/server";
import { effectiveLocalLlmConfig } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = effectiveLocalLlmConfig();
  if (!config) return NextResponse.json({ models: [] });
  
  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/models`, {
      headers: config.apiKey && config.apiKey !== "local" ? { Authorization: `Bearer ${config.apiKey}` } : {}
    });
    if (!res.ok) return NextResponse.json({ models: [] });
    
    const data = await res.json() as { data?: Array<{ id: string }> };
    const models = data.data?.map(m => m.id) || [];
    return NextResponse.json({ models });
  } catch {
    return NextResponse.json({ models: [] });
  }
}
