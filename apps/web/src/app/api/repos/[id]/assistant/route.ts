import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceDir } from "@/lib/store";
import { repoAccessDenied } from "@/lib/authz";
import { getSession } from "@/lib/session";
import { aiAssistantConfigured, resetAssistantSession, sendMessage } from "@/lib/agents/assistant";
import { localLlmConfigured, resetLocalAssistantSession, sendLocalMessage } from "@/lib/agents/localAssistant";
import { effectiveLocalLlmConfig, effectiveClaudeModel, ANONYMOUS_USER_ID } from "@/lib/settings";
import type { AssistantProvider, AssistantProviders } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGE_LENGTH = 8000;

function userIdFrom(req: NextRequest): number {
  return getSession(req)?.userId ?? ANONYMOUS_USER_ID;
}

function providers(userId: number): AssistantProviders {
  const local = effectiveLocalLlmConfig(userId);
  return {
    claude: aiAssistantConfigured(userId),
    local: !!local,
    claudeModel: effectiveClaudeModel(userId),
    localModel: local?.model,
  };
}

// GET /api/repos/:id/assistant -> { providers } — lets the Editor UI decide
// whether to show the AI Assistant tab, and which backend(s) to offer.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  return NextResponse.json({ providers: providers(userIdFrom(req)) });
}

// POST /api/repos/:id/assistant  { message: string, provider?: "claude" | "local" }
// -> text/event-stream of AssistantEvent frames for one conversation turn.
// `provider` defaults to Claude if configured, else the local model if that
// alone is configured.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;

  const ws = getWorkspaceDir(id);
  if (!ws) return NextResponse.json({ error: "Workspace not ready" }, { status: 404 });

  let body: { message?: unknown; provider?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `message is too long (max ${MAX_MESSAGE_LENGTH} characters)` }, { status: 400 });
  }

  const userId = userIdFrom(req);
  const available = providers(userId);
  const requested = body.provider === "claude" || body.provider === "local" ? body.provider : undefined;
  const provider: AssistantProvider | undefined = requested ?? (available.claude ? "claude" : available.local ? "local" : undefined);
  if (!provider || !available[provider]) {
    return NextResponse.json(
      {
        error: provider
          ? `The "${provider}" AI Assistant provider is not configured on this deployment.`
          : "No AI Assistant provider is configured on this deployment (set ANTHROPIC_API_KEY and/or CG_LOCAL_LLM_BASE_URL + CG_LOCAL_LLM_MODEL).",
      },
      { status: 501 },
    );
  }

  const hasGit = ws.sourceType === "git";
  const events = provider === "claude"
    ? sendMessage(id, ws.dir, hasGit, message, userId, req.signal)
    : sendLocalMessage(id, ws.dir, hasGit, message, userId, req.signal);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "error", message: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// DELETE /api/repos/:id/assistant -> closes the repo's in-process assistant
// session(s) ("New chat"); safe to call even if none exist.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const userId = userIdFrom(req);
  resetAssistantSession(id, userId);
  resetLocalAssistantSession(id, userId);
  return NextResponse.json({ ok: true });
}
