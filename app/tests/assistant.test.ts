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

  it("is still false with CG_CLAUDE_USE_SUBSCRIPTION=true alone -- toggling the box is not evidence the server can actually authenticate (this is the exact bug that produced 'Not logged in - Please run /login')", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CG_CLAUDE_USE_SUBSCRIPTION = "true";
    expect(aiAssistantConfigured()).toBe(false);
  });

  it("is true with CG_CLAUDE_USE_SUBSCRIPTION=true once CLAUDE_CODE_OAUTH_TOKEN gives real evidence of a usable login", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CG_CLAUDE_USE_SUBSCRIPTION = "true";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token";
    try {
      expect(aiAssistantConfigured()).toBe(true);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
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

// Regression guard: the SDK's CLI refuses `--dangerously-skip-permissions`
// outright when the process runs as root ("cannot be used with root/sudo
// privileges for security reasons") — and this app's Docker runtime
// deliberately runs as root, so `permissionMode: "bypassPermissions"` +
// `allowDangerouslySkipPermissions: true` crashed every real assistant
// turn in production. `getOrCreateSession`'s `Options` object isn't
// exported (it's only ever constructed in-process around a live SDK
// `query()` call, which needs a real API key/subprocess to exercise), so
// this locks in the fix the same way db.test.ts locks in schema/SQL
// wiring: by asserting the actual source no longer contains the
// root-incompatible flags, and does use the `canUseTool` auto-allow
// callback in their place.
describe("assistant.ts session Options — root-container permission mode", () => {
  it("never re-introduces bypassPermissions/allowDangerouslySkipPermissions, and does use canUseTool", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "lib", "agents", "assistant.ts"), "utf8");
    expect(src).not.toContain('permissionMode: "bypassPermissions"');
    expect(src).not.toContain("allowDangerouslySkipPermissions:"); // actual Options key, not the explanatory comment above
    expect(src).toContain("canUseTool:");
    expect(src).toContain('behavior: "allow"');
  });
});

// Regression guard for the "Not logged in" defense-in-depth net in
// sendMessage: a CLAUDE_CODE_OAUTH_TOKEN present at process start could
// still be revoked mid-runtime, or a `claude login` credentials file could
// be removed out from under a long-lived server. Without this detection,
// the CLI's own auth-failure onboarding text ("Not logged in - Please run
// /login", "/login isn't available in this environment") comes back as an
// ordinary assistant text block and renders as if Claude itself said it.
describe("assistant.ts sendMessage — CLI auth-failure text detection", () => {
  it("still detects and redirects the exact known CLI onboarding strings to a clear error", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "lib", "agents", "assistant.ts"), "utf8");
    expect(src).toContain("Not logged in");
    expect(src).toContain("isn't available in this environment");
    expect(src).toContain("This server's Claude subscription login isn't available right now");
  });
});

// Regression guard for a real, live-reproduced bug: AssistantPanel.tsx's
// `applyEvent` used to mutate `pathsToTouch`/`shouldMutate` *inside* the
// `setTurns` state-updater callback, then read those same variables
// immediately after calling `setTurns()`. React does not guarantee an
// updater function has actually run by the time `setState()` returns
// (especially here, since every event arrives from an async stream-reader
// loop, not a synchronous React event handler) — so `onMutated()` was
// silently skipped on every real successful write. Reproduced live end-
// to-end (real browser, real SSE stream, a fake OpenAI-compatible server
// standing in for the LLM): a `write_file` call genuinely succeeded (the
// file landed on disk, the assistant correctly reported success), but the
// file explorer never refreshed to show it. No React Testing Library/jsdom
// harness exists in this project to drive AssistantPanel directly (see the
// permission-mode and CLI-auth-detection guards above for the same
// convention), so this locks in the fix at the source level: the mutation
// flags must be computed from a synchronous ref BEFORE `setTurns` is
// called, never read from variables a state updater was responsible for
// setting.
describe("AssistantPanel.tsx applyEvent — no setState-timing hazard on file-mutation detection", () => {
  it("computes pathsToTouch/shouldMutate before calling setTurns, via a ref, not by reading variables a state updater sets", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "components", "editor", "AssistantPanel.tsx"), "utf8");
    const setTurnsIdx = src.indexOf("setTurns((prev) => {\n        const next = [...prev];\n        const last = next[next.length - 1];\n        if (!last || last.role !== \"assistant\")");
    const pathsIdx = src.indexOf("let pathsToTouch");
    expect(setTurnsIdx).toBeGreaterThan(-1);
    expect(pathsIdx).toBeGreaterThan(-1);
    // The mutation-flag computation must appear BEFORE the setTurns call in
    // source order -- i.e. it no longer depends on that updater having run.
    expect(pathsIdx).toBeLessThan(setTurnsIdx);
    expect(src).toContain("runningToolInputRef");
  });
});
