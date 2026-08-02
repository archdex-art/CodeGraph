// Regression tests for the local-LLM AI Assistant backend — the hand-rolled
// half of the feature (no vendor SDK backs this one, unlike assistant.ts's
// Claude Agent SDK path). Runs the real agent loop (fetch, tool-call
// dispatch, multi-turn looping) against a tiny in-process HTTP server that
// speaks just enough of the OpenAI chat-completions wire format to drive
// every branch deterministically — no real model server required.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantEvent } from "@/lib/types";
import { localLlmConfigured, resetLocalAssistantSession, sendLocalMessage } from "@/lib/agents/localAssistant";

type ChatCompletionResponder = (body: { messages: Array<{ role: string; content: unknown }> }) => {
  status?: number;
  content?: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

/** Starts a minimal OpenAI-compatible /chat/completions mock server on an
 *  ephemeral port and points CG_LOCAL_LLM_BASE_URL/CG_LOCAL_LLM_MODEL at it. */
async function startMockServer(respond: ChatCompletionResponder): Promise<{ server: Server; requestCount: () => number }> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requestCount++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = respond(body);
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: result.content ?? null, tool_calls: result.tool_calls ?? [] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind mock server");
  process.env.CG_LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.CG_LOCAL_LLM_MODEL = "test-model";
  return { server, requestCount: () => requestCount };
}

async function drain(gen: AsyncGenerator<AssistantEvent>): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("localLlmConfigured", () => {
  const savedUrl = process.env.CG_LOCAL_LLM_BASE_URL;
  const savedModel = process.env.CG_LOCAL_LLM_MODEL;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.CG_LOCAL_LLM_BASE_URL;
    else process.env.CG_LOCAL_LLM_BASE_URL = savedUrl;
    if (savedModel === undefined) delete process.env.CG_LOCAL_LLM_MODEL;
    else process.env.CG_LOCAL_LLM_MODEL = savedModel;
  });

  it("requires BOTH base URL and model to be set", () => {
    delete process.env.CG_LOCAL_LLM_BASE_URL;
    delete process.env.CG_LOCAL_LLM_MODEL;
    expect(localLlmConfigured()).toBe(false);

    process.env.CG_LOCAL_LLM_BASE_URL = "http://localhost:11434/v1";
    expect(localLlmConfigured()).toBe(false); // model still missing

    process.env.CG_LOCAL_LLM_MODEL = "qwen2.5-coder";
    expect(localLlmConfigured()).toBe(true);
  });
});

describe("sendLocalMessage — agent loop against a mock OpenAI-compatible server", () => {
  let root: string;
  let server: Server;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cg-local-llm-"));
    writeFileSync(path.join(root, "hello.txt"), "hello from the workspace");
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    resetLocalAssistantSession("repo-1");
    if (server) await new Promise((r) => server.close(r));
    delete process.env.CG_LOCAL_LLM_BASE_URL;
    delete process.env.CG_LOCAL_LLM_MODEL;
  });

  it("returns plain text with no tool calls in one round trip", async () => {
    ({ server } = await startMockServer(() => ({ content: "Hello from the local model" })));

    const events = await drain(sendLocalMessage("repo-1", root, false, "hi"));

    expect(events).toEqual([
      { kind: "text", text: "Hello from the local model" },
      { kind: "done", costUsd: 0, turns: 1 },
    ]);
  });

  it("executes a real tool call, feeds the result back, and returns the model's follow-up text", async () => {
    let call = 0;
    ({ server } = await startMockServer((body) => {
      call++;
      if (call === 1) {
        return { tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } }] };
      }
      // Second turn: the tool result must have been appended as a `tool` message.
      const toolMsg = body.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toBe("hello from the workspace");
      return { content: "The file says: hello from the workspace" };
    }));

    const events = await drain(sendLocalMessage("repo-1", root, false, "read hello.txt"));

    expect(events).toEqual([
      { kind: "tool_call", tool: "read_file", input: { path: "hello.txt" } },
      { kind: "tool_result", tool: "read_file", ok: true, summary: "hello from the workspace" },
      { kind: "text", text: "The file says: hello from the workspace" },
      { kind: "done", costUsd: 0, turns: 2 },
    ]);
  });

  it("rejects a write_file path traversal attempt through the real tool dispatcher", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "cg-local-llm-outside-"));
    const escapeTarget = path.join(outside, "pwned.txt");
    const relTraversal = path.relative(root, escapeTarget);
    let call = 0;
    ({ server } = await startMockServer(() => {
      call++;
      if (call === 1) {
        return {
          tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: relTraversal, content: "pwned" }) } }],
        };
      }
      return { content: "done" };
    }));

    const events = await drain(sendLocalMessage("repo-1", root, false, "escape the workspace"));

    const toolResult = events.find((e) => e.kind === "tool_result");
    expect(toolResult).toMatchObject({ kind: "tool_result", ok: false });
    expect(existsSync(escapeTarget)).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("surfaces a clear error instead of crashing when a tool call has malformed JSON arguments", async () => {
    ({ server } = await startMockServer(() => ({
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{not valid json" } }],
    })));

    const events = await drain(sendLocalMessage("repo-1", root, false, "break it"));
    const result = events.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", tool: "read_file", ok: false });
  });

  it("never exposes git tools when hasGit is false, and rejects a git tool call cleanly", async () => {
    ({ server } = await startMockServer(() => ({
      tool_calls: [{ id: "call_1", type: "function", function: { name: "git_status", arguments: "{}" } }],
    })));

    const events = await drain(sendLocalMessage("repo-1", root, false, "check git status"));
    const result = events.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ ok: false, summary: expect.stringContaining("Not a git workspace") });
  });

  it("stops with a terminal error instead of looping forever past the max tool-call turns", async () => {
    ({ server } = await startMockServer(() => ({
      tool_calls: [{ id: "call_1", type: "function", function: { name: "list_directory", arguments: JSON.stringify({ path: "." }) } }],
    })));

    const events = await drain(sendLocalMessage("repo-1", root, false, "loop forever"));
    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: "error" });
    if (last.kind !== "error") throw new Error("expected a terminal error event");
    expect(last.message).toMatch(/exceeded/i);
  });

  it("surfaces an HTTP error from the server as a graceful error event, not a thrown exception", async () => {
    ({ server } = await startMockServer(() => ({ status: 500, content: "should not be used" })));

    const events = await drain(sendLocalMessage("repo-1", root, false, "trigger a failure"));
    expect(events).toEqual([expect.objectContaining({ kind: "error" })]);
  });

  it("persists conversation across turns within the same repo session", async () => {
    ({ server } = await startMockServer((body) => {
      const userTurns = body.messages.filter((m) => m.role === "user").length;
      return { content: `saw ${userTurns} user turn(s)` };
    }));

    const first = await drain(sendLocalMessage("repo-1", root, false, "first"));
    expect(first[0]).toEqual({ kind: "text", text: "saw 1 user turn(s)" });

    const second = await drain(sendLocalMessage("repo-1", root, false, "second"));
    expect(second[0]).toEqual({ kind: "text", text: "saw 2 user turn(s)" });
  });
});
