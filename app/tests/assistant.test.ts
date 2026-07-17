// Regression tests for the opt-in AI Assistant's tool surface — the one
// place in CodeGraph that grants an LLM write access to a repo workspace.
// These test the actual exported `workspaceTools()` handlers directly
// (no CLI subprocess, no network, no API key) against a real temp
// directory, so they exercise the real path-safety and hasGit-gating
// behavior rather than a mock of it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantEvent } from "@/lib/types";
import { aiAssistantConfigured, workspaceTools, type WorkspaceTool } from "@/lib/agents/assistant";

function toolNames(tools: WorkspaceTool[]): string[] {
  return tools.map((t) => t.name);
}

function findTool(tools: WorkspaceTool[], name: string): WorkspaceTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe("aiAssistantConfigured", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  const originalSub = process.env.CG_CLAUDE_USE_SUBSCRIPTION;
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    if (originalSub === undefined) delete process.env.CG_CLAUDE_USE_SUBSCRIPTION;
    else process.env.CG_CLAUDE_USE_SUBSCRIPTION = originalSub;
  });

  it("is false when ANTHROPIC_API_KEY is unset and subscription mode is off", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CG_CLAUDE_USE_SUBSCRIPTION;
    expect(aiAssistantConfigured()).toBe(false);
  });

  it("is true once ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    expect(aiAssistantConfigured()).toBe(true);
  });

  it("is true with no API key when CG_CLAUDE_USE_SUBSCRIPTION=true (Claude Pro/Max login)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CG_CLAUDE_USE_SUBSCRIPTION = "true";
    expect(aiAssistantConfigured()).toBe(true);
  });
});

describe("workspaceTools — tool surface", () => {
  it("registers exactly the fs tools, no git tools, when hasGit is false", () => {
    const names = toolNames(workspaceTools("repo-id", "/tmp/irrelevant", false, () => {}));
    expect(names.sort()).toEqual(
      ["create_entry", "delete_entry", "list_directory", "read_file", "rename_entry", "search_workspace", "write_file"].sort(),
    );
  });

  it("adds exactly the three git tools when hasGit is true", () => {
    const names = toolNames(workspaceTools("repo-id", "/tmp/irrelevant", true, () => {}));
    expect(names).toContain("git_status");
    expect(names).toContain("git_diff");
    expect(names).toContain("git_commit");
    expect(names.length).toBe(10);
  });

  it("never registers a Bash/shell/exec tool of any name", () => {
    const names = toolNames(workspaceTools("repo-id", "/tmp/irrelevant", true, () => {}));
    for (const n of names) expect(n.toLowerCase()).not.toMatch(/bash|shell|exec|command/);
  });
});

describe("workspaceTools — path safety (the actual security boundary)", () => {
  let root: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cg-assistant-root-"));
    outsideDir = mkdtempSync(path.join(tmpdir(), "cg-assistant-outside-"));
    writeFileSync(path.join(root, "hello.txt"), "hello from the workspace");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("read_file returns real content for an in-workspace path", async () => {
    const tools = workspaceTools("repo-id", root, false, () => {});
    const result = await findTool(tools, "read_file").handler({ path: "hello.txt" }, undefined);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "hello from the workspace" }]);
  });

  it("write_file rejects a `../` traversal attempt and never touches disk outside the workspace", async () => {
    const tools = workspaceTools("repo-id", root, false, () => {});
    const escapeTarget = path.join(outsideDir, "pwned.txt");
    const relTraversal = path.relative(root, escapeTarget); // e.g. "../cg-assistant-outside-xxx/pwned.txt"

    const result = await findTool(tools, "write_file").handler({ path: relTraversal, content: "pwned" }, undefined);

    expect(result.isError).toBe(true);
    expect(existsSync(escapeTarget)).toBe(false);
  });

  it("read_file rejects a `../../../etc/passwd`-style traversal attempt", async () => {
    const tools = workspaceTools("repo-id", root, false, () => {});
    const result = await findTool(tools, "read_file").handler({ path: "../../../etc/passwd" }, undefined);
    expect(result.isError).toBe(true);
  });

  it("write_file succeeds for an in-workspace path and the bytes land on disk", async () => {
    const tools = workspaceTools("repo-id", root, false, () => {});
    const result = await findTool(tools, "write_file").handler({ path: "new/nested/file.txt", content: "written by the assistant" }, undefined);
    expect(result.isError).toBeFalsy();
    expect(readFileSync(path.join(root, "new/nested/file.txt"), "utf8")).toBe("written by the assistant");
  });

  it("git tools are absent entirely when hasGit is false — no shell-out is even reachable", () => {
    const tools = workspaceTools("repo-id", root, false, () => {});
    expect(tools.find((t) => t.name.startsWith("git_"))).toBeUndefined();
  });

  it("emits a tool_call then a tool_result event around every call, success and failure alike", async () => {
    const events: AssistantEvent[] = [];
    const tools = workspaceTools("repo-id", root, false, (e) => events.push(e));

    await findTool(tools, "read_file").handler({ path: "hello.txt" }, undefined);
    await findTool(tools, "read_file").handler({ path: "../../etc/passwd" }, undefined);

    expect(events.map((e) => e.kind)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    expect(events[1]).toMatchObject({ kind: "tool_result", tool: "read_file", ok: true });
    expect(events[3]).toMatchObject({ kind: "tool_result", tool: "read_file", ok: false });
  });
});
