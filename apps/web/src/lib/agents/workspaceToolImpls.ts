// The actual business logic behind every AI-assistant tool — shared by both
// backends (`assistant.ts` for Claude, `localAssistant.ts` for any
// OpenAI-compatible local model server). Each function is a thin wrapper
// over the exact same path-safe helpers the human-facing Editor UI already
// uses (`workspace.ts`'s `resolveSafe`-guarded fs ops, `gitops.ts`'s
// argv-only git wrapper): a prompt-injected or hallucinated path can't
// escape the workspace root regardless of which model is driving the chat.
//
// This module knows nothing about Claude, MCP, OpenAI, or JSON schemas — it
// is pure "given validated arguments, do the thing, return text or throw."
// Each backend owns its own tool-declaration format (zod for the Claude
// Agent SDK, JSON Schema for OpenAI-style function calling).
import { createEntry, listDir, readWorkspaceFile, renameEntry, searchWorkspace, writeWorkspaceFile } from "../workspace";
import { commit, diffFile, getStatus } from "../gitops";
import { moveToTrash } from "../trash";

export interface WorkspaceToolImpls {
  list_directory(input: { path: string }): string;
  read_file(input: { path: string }): string;
  write_file(input: { path: string; content: string }): string;
  create_entry(input: { path: string; type: "file" | "dir" }): string;
  rename_entry(input: { from: string; to: string }): string;
  delete_entry(input: { path: string }): string;
  search_workspace(input: { query: string }): string;
}

export interface GitToolImpls {
  git_status(): Promise<string>;
  git_diff(input: { path: string }): Promise<string>;
  git_commit(input: { message: string }): Promise<string>;
}

export function buildWorkspaceToolImpls(repoId: string, root: string): WorkspaceToolImpls {
  return {
    list_directory({ path }) {
      const entries = listDir(root, path);
      if (!entries.length) return "(empty)";
      return entries.map((e) => `${e.type === "dir" ? "d" : "f"} ${e.path}`).join("\n");
    },
    read_file({ path }) {
      const res = readWorkspaceFile(root, path);
      if (res.binary) throw new Error("File is binary and cannot be read as text.");
      return res.content;
    },
    write_file({ path, content }) {
      writeWorkspaceFile(root, path, content);
      return `Wrote ${content.length} bytes to ${path}.`;
    },
    create_entry({ path, type }) {
      createEntry(root, path, type);
      return `Created ${type} ${path}.`;
    },
    rename_entry({ from, to }) {
      renameEntry(root, from, to);
      return `Renamed ${from} -> ${to}.`;
    },
    delete_entry({ path }) {
      moveToTrash(repoId, root, path);
      return `Moved ${path} to trash.`;
    },
    search_workspace({ query }) {
      const matches = searchWorkspace(root, query);
      if (!matches.length) return "No matches.";
      return matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
    },
  };
}

export function buildGitToolImpls(root: string): GitToolImpls {
  return {
    async git_status() {
      const st = await getStatus(root);
      if (!st.entries.length) return "Clean working tree.";
      return st.entries.map((e) => `${e.status} ${e.path}`).join("\n");
    },
    async git_diff({ path }) {
      return diffFile(root, path);
    },
    async git_commit({ message }) {
      return commit(root, message);
    },
  };
}
