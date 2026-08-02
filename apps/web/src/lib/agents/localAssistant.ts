// Opt-in AI Assistant backend #2: any OpenAI-compatible local model server
// (Ollama, LM Studio, llama.cpp's `server`, vLLM, text-generation-webui,
// ...) reached over plain HTTP. There is no vendor SDK to lean on here (the
// Claude Agent SDK in `assistant.ts` only speaks Anthropic's wire format),
// so this hand-rolls the same shape of agent loop: send messages + tool
// schemas, execute any requested tool calls, feed results back, repeat
// until the model returns plain text.
//
// Same security posture as the Claude backend: the model gets exactly the
// nine tools in `workspaceToolImpls.ts` — no shell, no raw filesystem
// access beyond the path-safe `workspace.ts`/`gitops.ts` wrappers everyone
// else in the app uses. Off by default: inert unless both
// `CG_LOCAL_LLM_BASE_URL` and `CG_LOCAL_LLM_MODEL` are set.
import { buildGitToolImpls, buildWorkspaceToolImpls, type GitToolImpls, type WorkspaceToolImpls } from "./workspaceToolImpls";
import { effectiveLocalLlmConfig, type EffectiveLocalLlmConfig, ANONYMOUS_USER_ID } from "../settings";
import type { AssistantEvent } from "../types";

export function localLlmConfigured(userId: number = ANONYMOUS_USER_ID): boolean {
  return effectiveLocalLlmConfig(userId) !== null;
}

const MAX_TOOL_TURNS = 20;
const MAX_RESULT_CHARS = 500;
const SYSTEM_PROMPT = (hasGit: boolean) =>
  "You are the AI Assistant embedded in CodeGraph's built-in code editor, running on the user's own " +
  "local model. You help the user read, understand, and edit files in the repository they currently " +
  "have open, directly in this chat.\n\n" +
  "You can ONLY interact with the repository through the provided tools — all paths are relative to " +
  "the repository root, forward-slash separated, and every path is validated server-side; a path " +
  "that tries to escape the repository will be rejected.\n\n" +
  "CRITICAL RULES FOR EDITING FILES:\n" +
  "1. To edit a file, you MUST call the `write_file` tool. Do NOT just output a code block in your response. Outputting markdown code blocks does not edit files.\n" +
  "2. Always call `read_file` before `write_file` on an existing file so you never clobber unrelated content.\n" +
  "3. Make focused, minimal changes that match the surrounding code style.\n" +
  "4. Never invent file contents you have not actually read. Be concise.\n" +
  (hasGit ? "" : "This is not a git workspace, so no git tools are available.");

type JsonSchema = Record<string, unknown>;

interface OpenAiToolDef {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

function toolDef(name: string, description: string, properties: Record<string, JsonSchema>, required: string[]): OpenAiToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const STRING_PARAM = { type: "string" };

function toolDefs(hasGit: boolean): OpenAiToolDef[] {
  const defs = [
    toolDef(
      "list_directory",
      "List files and subdirectories one level deep at a path in the repository workspace.",
      { path: { type: "string", description: "Path relative to the workspace root, e.g. '.' or 'src/lib'." } },
      ["path"],
    ),
    toolDef("read_file", "Read the full text contents of one file in the repository workspace.", { path: STRING_PARAM }, ["path"]),
    toolDef(
      "write_file",
      "Create or overwrite a file with FULL new contents (not a diff/patch). Always read_file first if the file already exists.",
      { path: STRING_PARAM, content: STRING_PARAM },
      ["path", "content"],
    ),
    toolDef(
      "create_entry",
      "Create a new empty file or directory.",
      { path: STRING_PARAM, type: { type: "string", enum: ["file", "dir"] } },
      ["path", "type"],
    ),
    toolDef("rename_entry", "Rename or move a file or directory to a new path.", { from: STRING_PARAM, to: STRING_PARAM }, ["from", "to"]),
    toolDef(
      "search_workspace",
      "Plain-text search across the repository's files. Returns matching file:line results.",
      { query: STRING_PARAM },
      ["query"],
    ),
    toolDef("delete_entry", "Move a file or directory to the trash.", { path: STRING_PARAM }, ["path"]),
  ];
  if (hasGit) {
    defs.push(
      toolDef("git_status", "Show the working tree status: modified/added/deleted/untracked files.", {}, []),
      toolDef("git_diff", "Show the diff for one file against the last commit.", { path: STRING_PARAM }, ["path"]),
      toolDef("git_commit", "Stage ALL current changes in the workspace and commit them with a message.", { message: STRING_PARAM }, ["message"]),
    );
  }
  return defs;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing or invalid "${key}" argument.`);
  return v;
}

function requireFileOrDir(args: Record<string, unknown>, key: string): "file" | "dir" {
  const v = args[key];
  if (v !== "file" && v !== "dir") throw new Error(`"${key}" must be "file" or "dir".`);
  return v;
}

/** Dispatches one tool call by name to the shared implementations, with
 *  defensive argument validation (a local model's function-call JSON is far
 *  less reliable than the Claude Agent SDK's own zod-validated tool_use). */
function buildToolRunner(repoId: string, root: string, hasGit: boolean): (name: string, args: Record<string, unknown>) => Promise<string> {
  const fs: WorkspaceToolImpls = buildWorkspaceToolImpls(repoId, root);
  const git: GitToolImpls | null = hasGit ? buildGitToolImpls(root) : null;

  return async (name, args) => {
    switch (name) {
      case "list_directory":
        return fs.list_directory({ path: requireString(args, "path") });
      case "read_file":
        return fs.read_file({ path: requireString(args, "path") });
      case "write_file":
        return fs.write_file({ path: requireString(args, "path"), content: requireString(args, "content") });
      case "create_entry":
        return fs.create_entry({ path: requireString(args, "path"), type: requireFileOrDir(args, "type") });
      case "rename_entry":
        return fs.rename_entry({ from: requireString(args, "from"), to: requireString(args, "to") });
      case "search_workspace":
        return fs.search_workspace({ query: requireString(args, "query") });
      case "delete_entry":
        return fs.delete_entry({ path: requireString(args, "path") });
      case "git_status":
        if (!git) throw new Error("Not a git workspace.");
        return git.git_status();
      case "git_diff":
        if (!git) throw new Error("Not a git workspace.");
        return git.git_diff({ path: requireString(args, "path") });
      case "git_commit":
        if (!git) throw new Error("Not a git workspace.");
        return git.git_commit({ message: requireString(args, "message") });
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

async function callChatCompletions(
  config: EffectiveLocalLlmConfig,
  messages: ChatMessage[],
  tools: OpenAiToolDef[],
  signal?: AbortSignal,
): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Local LLM request to ${baseUrl} failed (${res.status}): ${body.slice(0, 300) || res.statusText}`);
  }
  const rawText = await res.text();
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Local LLM returned invalid JSON: ${rawText.slice(0, 200)}`);
  }
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error(`Local LLM returned no completion choice. Raw response: ${rawText.slice(0, 300)}`);
  }
  return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
}

interface LocalSession {
  messages: ChatMessage[];
  workspaceDir: string;
  configKey: string;
}

// Mirrors the per-(repo,account) in-process session map in `assistant.ts`
// — separate Map because a Claude conversation and a local-model
// conversation for the same repo are unrelated histories, never merged.
// Keyed by account too: a shared public-bucket repo open in two different
// signed-in accounts' editors must never share one local-model session.
const sessions = new Map<string, LocalSession>();

function sessionKey(repoId: string, userId: number): string {
  return `${repoId}:${userId}`;
}

function getOrCreateSession(key: string, workspaceDir: string, hasGit: boolean, configKey: string): LocalSession {
  const existing = sessions.get(key);
  if (existing && existing.workspaceDir === workspaceDir && existing.configKey === configKey) return existing;
  const session: LocalSession = { messages: [{ role: "system", content: SYSTEM_PROMPT(hasGit) }], workspaceDir, configKey };
  sessions.set(key, session);
  return session;
}

/** Same contract as `assistant.ts`'s `sendMessage`: sends one user message,
 *  yields normalized events as the turn plays out (looping through any
 *  tool calls the model makes), then a terminal `done`/`error`. */
export async function* sendLocalMessage(
  repoId: string,
  workspaceDir: string,
  hasGit: boolean,
  text: string,
  userId: number = ANONYMOUS_USER_ID,
  signal?: AbortSignal,
): AsyncGenerator<AssistantEvent> {
  const config = effectiveLocalLlmConfig(userId);
  if (!config) throw new Error("Local LLM is not configured");
  const configKey = `${config.baseUrl}|${config.model}|${config.apiKey}`;
  const session = getOrCreateSession(sessionKey(repoId, userId), workspaceDir, hasGit, configKey);
  session.messages.push({ role: "user", content: text });
  const runTool = buildToolRunner(repoId, workspaceDir, hasGit);
  const tools = toolDefs(hasGit);

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const { content, toolCalls } = await callChatCompletions(config, session.messages, tools, signal);

      if (toolCalls.length === 0) {
        session.messages.push({ role: "assistant", content: content ?? "" });
        if (content) yield { kind: "text", text: content };
        yield { kind: "done", costUsd: 0, turns: turn + 1 };
        return;
      }

      session.messages.push({ role: "assistant", content, tool_calls: toolCalls });
      if (content) yield { kind: "text", text: content };

      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Leave args empty — the validator inside runTool will raise a clear error.
        }
        yield { kind: "tool_call", tool: call.function.name, input: args };

        let ok = true;
        let resultText: string;
        try {
          resultText = await runTool(call.function.name, args);
        } catch (e) {
          ok = false;
          resultText = e instanceof Error ? e.message : String(e);
        }
        const summary = resultText.length > MAX_RESULT_CHARS ? `${resultText.slice(0, MAX_RESULT_CHARS)}…` : resultText;
        yield { kind: "tool_result", tool: call.function.name, ok, summary };
        session.messages.push({ role: "tool", tool_call_id: call.id, content: ok ? resultText : `Error: ${resultText}` });
      }
    }
    yield { kind: "error", message: `Assistant stopped: exceeded ${MAX_TOOL_TURNS} tool-call turns without a final answer.` };
  } catch (e) {
    yield { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Closes and discards a repo's local-model session ("New chat"). */
export function resetLocalAssistantSession(repoId: string, userId: number = ANONYMOUS_USER_ID): void {
  sessions.delete(sessionKey(repoId, userId));
}
