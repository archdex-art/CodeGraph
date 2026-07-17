import { NextRequest, NextResponse } from "next/server";
import { effectiveLocalLlmConfig, effectiveLocalModelList } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// By default returns the user's curated model list (added/removed from
// /settings) so the chat panel's dropdown stays short and intentional
// instead of dumping a provider's full, often huge, raw catalog. Pass
// ?discover=true to bypass the curation and fetch the provider's live
// /v1/models list instead -- used by the "Discover from server" picker on
// the Settings page when the user wants to browse what's actually available.
export async function GET(req: NextRequest) {
  const curated = effectiveLocalModelList();
  const discover = req.nextUrl.searchParams.get("discover") === "true";
  if (curated.length > 0 && !discover) {
    return NextResponse.json({ models: curated, curated: true });
  }

  const config = effectiveLocalLlmConfig();
  if (!config) return NextResponse.json({ models: curated, curated: curated.length > 0 });

  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/models`, {
      headers: config.apiKey && config.apiKey !== "local" ? { Authorization: `Bearer ${config.apiKey}` } : {}
    });
    if (!res.ok) return NextResponse.json({ models: curated, curated: curated.length > 0 });

    const data = await res.json() as { data?: Array<{ id: string }> };
    const models = data.data?.map(m => m.id) || [];
    return NextResponse.json({ models, curated: false });
  } catch {
    return NextResponse.json({ models: curated, curated: curated.length > 0 });
  }
}
