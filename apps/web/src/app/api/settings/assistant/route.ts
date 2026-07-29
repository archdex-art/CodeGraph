import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { githubOAuthConfigured } from "@/lib/githubOAuth";
import { deleteLocalProvider, saveLocalProvider, setAssistantSettings, applyLocalProvider, viewAssistantSettings, ANONYMOUS_USER_ID } from "@/lib/settings";
import { verifyAnthropicApiKey } from "@/lib/anthropicKeyCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(req: NextRequest): NextResponse | null {
  if (githubOAuthConfigured() && !getSession(req)?.userId) {
    return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
  }
  return null;
}

// Every value here is scoped to the calling account: `userId` derives from
// the signed-in session (falling back to the shared ANONYMOUS_USER_ID
// bucket only when GitHub sign-in isn't configured at all, or the
// deployment is genuinely unauthenticated). A saved key/model/profile is
// therefore visible and editable only from the GitHub account that saved
// it -- never a different signed-in user, never overwritten by one.
function userIdFrom(req: NextRequest): number {
  return getSession(req)?.userId ?? ANONYMOUS_USER_ID;
}

export async function GET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return NextResponse.json(viewAssistantSettings(userIdFrom(req)));
}

export async function POST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const userId = userIdFrom(req);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof setAssistantSettings>[0] = {};
  
  if (typeof body.anthropicApiKey === "string" || body.anthropicApiKey === null) {
    patch.anthropicApiKey = body.anthropicApiKey;
  }
  // Verify a newly pasted Anthropic key against Anthropic's own API before
  // ever persisting it -- previously any string was accepted silently and
  // only failed deep inside a real chat turn ("Invalid API key"), with no
  // way to tell a CodeGraph bug from a bad paste. A confirmed-invalid key
  // (401/403) is rejected here with Anthropic's own error text; a network
  // failure verifying it is NOT evidence the key is bad, so it still saves.
  if (typeof patch.anthropicApiKey === "string" && patch.anthropicApiKey.trim()) {
    const check = await verifyAnthropicApiKey(patch.anthropicApiKey.trim());
    if (!check.ok && check.reason === "invalid") {
      return NextResponse.json({ error: `Anthropic rejected this API key: ${check.message}` }, { status: 400 });
    }
  }
  if (typeof body.claudeModel === "string" || body.claudeModel === null) {
    patch.claudeModel = body.claudeModel;
  }
  if (typeof body.useClaudeSubscription === "boolean") {
    patch.useClaudeSubscription = body.useClaudeSubscription ? "true" : null;
  }
  if (typeof body.localBaseUrl === "string" || body.localBaseUrl === null) {
    patch.localBaseUrl = body.localBaseUrl;
  }
  if (typeof body.localModel === "string" || body.localModel === null) {
    patch.localModel = body.localModel;
  }
  if (typeof body.localApiKey === "string" || body.localApiKey === null) {
    patch.localApiKey = body.localApiKey;
  }
  if (Array.isArray(body.localModelList)) {
    const cleaned = body.localModelList.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
    patch.localModelList = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  } else if (body.localModelList === null) {
    patch.localModelList = null;
  }

  // Saved local-model provider profiles -- checked before the plain field
  // patch so a single POST can either mutate the active config directly, or
  // manage/apply a saved preset, without callers needing two round trips.
  if (body.saveProvider && typeof body.saveProvider === "object") {
    const p = body.saveProvider as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
    if (!name || !baseUrl) {
      return NextResponse.json({ error: "Profile name and base URL are required" }, { status: 400 });
    }
    const models = Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0) : [];
    saveLocalProvider({
      id: typeof p.id === "string" && p.id ? p.id : randomUUID(),
      name,
      baseUrl,
      apiKey: typeof p.apiKey === "string" && p.apiKey ? p.apiKey : null,
      models,
    }, userId);
  }
  if (typeof body.deleteProviderId === "string") {
    deleteLocalProvider(body.deleteProviderId, userId);
  }
  if (typeof body.useProviderId === "string") {
    if (!applyLocalProvider(body.useProviderId, userId)) {
      return NextResponse.json({ error: "Provider profile not found" }, { status: 404 });
    }
  }

  setAssistantSettings(patch, userId);

  // Return updated view
  return NextResponse.json(viewAssistantSettings(userId));
}
