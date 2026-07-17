// Opt-in AI Assistant for the built-in Editor: an in-process Claude Agent SDK
// session scoped to one repo's workspace directory.
//
// Security model (this is the one place in CodeGraph that grants an LLM
// write access to a repo): the agent gets NO built-in Claude Code tools
// (`tools: []` below disables Read/Write/Edit/Bash/WebFetch/etc. entirely)
// and NO filesystem settings/hooks/plugins (`settingSources: []`,
// `strictMcpConfig: true`). Its only capabilities are the nine custom tools
// defined here, and every one of them is a thin wrapper over the exact same
// path-safe helpers the human-facing Editor UI already uses
// (`workspace.ts`'s `resolveSafe`-guarded fs ops, `gitops.ts`'s argv-only git
// wrapper) — so a prompt-injected or hallucinated path can't escape the
// workspace root any more than a malicious click in the FileExplorer could.
// There is deliberately no Bash tool and no raw fs/shell access: "faster
// editing" does not require giving the model a shell on a multi-tenant host.
//
// Entirely off by default: every export here is inert unless
// `ANTHROPIC_API_KEY` is set (see `aiAssistantConfigured`), mirroring the
// GitHub OAuth opt-in pattern in `githubOAuth.ts`. The deterministic agent
// swarm (`orchestrator.ts`) needs no LLM and is unaffected either way.
import { createSdkMcpServer, query, tool, type Options, type Query, type SdkMcpToolDefinition, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildGitToolImpls, buildWorkspaceToolImpls } from "./workspaceToolImpls";
import { effectiveAnthropicApiKey, effectiveClaudeModel, effectiveUseClaudeSubscription } from "../settings";
import type { AssistantEvent } from "../types";

export function aiAssistantConfigured(): boolean {
  return !!effectiveAnthropicApiKey() || effectiveUseClaudeSubscription();
}

const SYSTEM_PROMPT = (hasGit: boolean) =>
  "You are the AI Assistant embedded in CodeGraph's built-in code editor. You help the user read, " +
  "understand, and edit files in the repository they currently have open, directly in this chat.\n\n" +
  "You can ONLY interact with the repository through these tools — all paths are relative to the " +
  "repository root, forward-slash separated, and every path is validated server-side; a path that " +
  "tries to escape the repository will be rejected:\n" +
  "- list_directory(path): list one directory level.\n" +
  "- read_file(path): read a text file's full contents.\n" +
  "- write_file(path, content): create or overwrite a file with FULL new contents.\n" +
  "- create_entry(path, type): create an empty file or directory.\n" +
  "- rename_entry(from, to): rename or move a file or directory.\n" +
  "- delete_entry(path): move a file or directory to the trash.\n" +
  "- search_workspace(query): plain-text search across the repo.\n" +
  (hasGit
    ? "- git_status(): working tree status.\n- git_diff(path): diff for one file.\n- git_commit(message): stage all changes and commit.\n"
    : "") +
  "\nRules: always read_file before write_file on an existing file so you never clobber unrelated " +
  "content. Make focused, minimal changes that match the surrounding code style. Never invent file " +
  "contents you have not actually read. Be concise — this is a chat panel, not a report.";

/** Runs one tool's body, emitting a `tool_call`/`tool_result` pair around it
 *  so the chat UI can render a live "Reading src/foo.ts…" style timeline.
 *  All nine tool definitions below funnel through this one function, so
 *  the emit/try-catch/summarize lockstep lives here exactly once. */
async function runTool(
  emit: (e: AssistantEvent) => void,
  toolName: string,
  input: Record<string, unknown>,
  body: () => string | Promise<string>,
): Promise<CallToolResult> {
  emit({ kind: "tool_call", tool: toolName, input });
  try {
    const text = await body();
    const summary = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    emit({ kind: "tool_result", tool: toolName, ok: true, summary });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ kind: "tool_result", tool: toolName, ok: false, summary: message });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** One entry in the assistant's fixed custom-tool surface. */
export type WorkspaceTool = SdkMcpToolDefinition<any>;

/** Builds the fixed set of custom MCP tools available to the assistant.
 *  Exported for direct testing of tool-handler behavior (path safety,
 *  hasGit gating) without spinning up the SDK's CLI subprocess. */
export function workspaceTools(repoId: string, root: string, hasGit: boolean, emit: (e: AssistantEvent) => void): WorkspaceTool[] {
  const impls = buildWorkspaceToolImpls(repoId, root);
  const tools: Array<SdkMcpToolDefinition<any>> = [
    tool(
      "list_directory",
      "List files and subdirectories one level deep at a path in the repository workspace.",
      { path: z.string().describe("Path relative to the workspace root, e.g. '.' or 'src/lib'.") },
      async ({ path }) => runTool(emit, "list_directory", { path }, () => impls.list_directory({ path })),
    ),
    tool(
      "read_file",
      "Read the full text contents of one file in the repository workspace.",
      { path: z.string() },
      async ({ path }) => runTool(emit, "read_file", { path }, () => impls.read_file({ path })),
    ),
    tool(
      "write_file",
      "Create or overwrite a file with FULL new contents (not a diff/patch). Always read_file " +
        "first if the file already exists.",
      { path: z.string(), content: z.string() },
      async ({ path, content }) =>
        runTool(emit, "write_file", { path, bytes: content.length }, () => impls.write_file({ path, content })),
    ),
    tool(
      "create_entry",
      "Create a new empty file or directory.",
      { path: z.string(), type: z.enum(["file", "dir"]) },
      async ({ path, type }) => runTool(emit, "create_entry", { path, type }, () => impls.create_entry({ path, type })),
    ),
    tool(
      "rename_entry",
      "Rename or move a file or directory to a new path.",
      { from: z.string(), to: z.string() },
      async ({ from, to }) => runTool(emit, "rename_entry", { from, to }, () => impls.rename_entry({ from, to })),
    ),
    tool(
      "delete_entry",
      "Move a file or directory to the trash.",
      { path: z.string() },
      async ({ path }) => runTool(emit, "delete_entry", { path }, () => impls.delete_entry({ path })),
    ),
    tool(
      "search_workspace",
      "Plain-text search across the repository's files. Returns matching file:line results.",
      { query: z.string() },
      async ({ query }) => runTool(emit, "search_workspace", { query }, () => impls.search_workspace({ query })),
    ),
  ];

  if (hasGit) {
    const gitImpls = buildGitToolImpls(root);
    tools.push(
      tool(
        "git_status",
        "Show the working tree status: modified/added/deleted/untracked files.",
        {},
        async () => runTool(emit, "git_status", {}, () => gitImpls.git_status()),
      ),
      tool(
        "git_diff",
        "Show the diff for one file against the last commit.",
        { path: z.string() },
        async ({ path }) => runTool(emit, "git_diff", { path }, () => gitImpls.git_diff({ path })),
      ),
      tool(
        "git_commit",
        "Stage ALL current changes in the workspace and commit them with a message.",
        { message: z.string() },
        async ({ message }) => runTool(emit, "git_commit", { message }, () => gitImpls.git_commit({ message })),
      ),
    );
  }

  return tools;
}

interface InputQueue extends AsyncIterable<SDKUserMessage> {
  push(msg: SDKUserMessage): void;
}

function createInputQueue(): InputQueue {
  const pending: SDKUserMessage[] = [];
  let waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  return {
    push(msg) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: msg, done: false });
      } else {
        pending.push(msg);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (pending.length > 0) return Promise.resolve({ value: pending.shift()!, done: false });
          const { promise, resolve } = Promise.withResolvers<IteratorResult<SDKUserMessage>>();
          waiting = resolve;
          return promise;
        },
      };
    },
  };
}

interface AssistantSession {
  query: Query;
  input: InputQueue;
  toolEvents: AssistantEvent[];
  workspaceDir: string;
  apiKey: string;
  useSubscription: boolean;
  model: string | undefined;
}

// One conversation per repo, kept alive in-process for the life of the Node
// server (same "no external queue, fire-and-forget in-process state" model
// `store.ts` already uses for jobs). Resets on server restart, deploy, an
// explicit `resetAssistantSession` call, or a changed API key from the
// Settings page — no transcript is ever written to disk (`persistSession:
// false` below), so there is nothing to clean up.
const sessions = new Map<string, AssistantSession>();

function getOrCreateSession(repoId: string, workspaceDir: string, hasGit: boolean): AssistantSession {
  const apiKey = effectiveAnthropicApiKey() ?? "";
  const useSubscription = !apiKey && effectiveUseClaudeSubscription();
  const model = effectiveClaudeModel();
  const existing = sessions.get(repoId);
  if (
    existing && existing.workspaceDir === workspaceDir && existing.apiKey === apiKey
    && existing.useSubscription === useSubscription && existing.model === model
  ) return existing;
  if (existing) {
    try {
      existing.query.close();
    } catch {
      /* already gone */
    }
    sessions.delete(repoId);
  }

  const toolEvents: AssistantEvent[] = [];
  const mcpServer = createSdkMcpServer({
    name: "workspace",
    version: "1.0.0",
    tools: workspaceTools(repoId, workspaceDir, hasGit, (e) => toolEvents.push(e)),
  });
  const input = createInputQueue();

  const options: Options = {
    cwd: workspaceDir,
    tools: [], // disable every built-in Claude Code tool (Read/Write/Edit/Bash/WebFetch/...)
    mcpServers: { workspace: mcpServer },
    strictMcpConfig: true, // ignore project .mcp.json / user settings — only the server above exists
    settingSources: [], // no CLAUDE.md, no user/project/local settings, no hooks, no plugins
    permissionMode: "bypassPermissions", // headless: no human to click "allow" per tool call
    allowDangerouslySkipPermissions: true,
    persistSession: false, // never write this repo's transcript to disk on a shared host
    maxTurns: 40,
    maxBudgetUsd: 5, // safety cap for the whole (possibly multi-turn) session
    systemPrompt: SYSTEM_PROMPT(hasGit),
    // Model alias/id resolved from the Settings page (DB) or CG_CLAUDE_MODEL
    // env var (e.g. "opus", "sonnet", "haiku"); omitted lets the SDK use its
    // own CLI default.
    ...(model ? { model } : {}),
    // Auth: an explicit key from the Settings page/ANTHROPIC_API_KEY always
    // wins. Otherwise, if "use my Claude subscription" is enabled, leave
    // ANTHROPIC_API_KEY unset entirely (don't even pass an empty string) so
    // the bundled Claude Code executable falls back to its own stored login
    // (`claude login`) or CLAUDE_CODE_OAUTH_TOKEN already present in this
    // process's environment -- billed against the Pro/Max/Team subscription
    // instead of per-token API usage. CodeGraph never sees those credentials.
    env: apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : { ...process.env },
  };

  const q = query({ prompt: input, options });
  const session: AssistantSession = { query: q, input, toolEvents, workspaceDir, apiKey, useSubscription, model };
  sessions.set(repoId, session);
  return session;

}

/** Sends one user message to the repo's assistant session (creating the
 *  session on first use) and yields normalized events as the turn plays
 *  out: interleaved tool calls/results, assistant text, then a terminal
 *  `done` or `error`. The underlying session stays open afterward so the
 *  next call continues the same conversation. */
export async function* sendMessage(
  repoId: string,
  workspaceDir: string,
  hasGit: boolean,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<AssistantEvent> {
  const session = getOrCreateSession(repoId, workspaceDir, hasGit);
  
  let aborted = false;
  if (signal) {
    const onAbort = () => {
      aborted = true;
      try { session.query.close(); } catch {}
      sessions.delete(repoId);
    };
    if (signal.aborted) {
      onAbort();
      yield { kind: "error", message: "Aborted" };
      return;
    }
    signal.addEventListener("abort", onAbort);
  }

  session.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

  try {
    for (;;) {
      if (aborted) {
        yield { kind: "error", message: "Aborted" };
        return;
      }
      const { value: msg, done } = await session.query.next();
      while (session.toolEvents.length > 0) yield session.toolEvents.shift()!;

      if (done || !msg) {
        sessions.delete(repoId);
        yield { kind: "error", message: "Assistant session ended unexpectedly." };
        return;
      }

      if (msg.type === "assistant") {
        const blocks = (msg.message.content ?? []) as Array<{ type: string; text?: string }>;
        for (const block of blocks) {
          if (block.type === "text" && block.text) yield { kind: "text", text: block.text };
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success") {
          yield { kind: "done", costUsd: msg.total_cost_usd, turns: msg.num_turns };
        } else {
          const detail = "errors" in msg && msg.errors.length ? msg.errors.join("; ") : msg.subtype;
          yield { kind: "error", message: `Assistant stopped: ${detail}` };
        }
        return;
      }
      // Other message types (system/init, partial streaming deltas, hook
      // lifecycle, etc.) carry nothing the chat panel needs to render.
    }
  } catch (e) {
    sessions.delete(repoId);
    yield { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Closes and discards a repo's assistant session ("New chat"). */
export function resetAssistantSession(repoId: string): void {
  const session = sessions.get(repoId);
  if (!session) return;
  try {
    session.query.close();
  } catch {
    /* already gone */
  }
  sessions.delete(repoId);
}
