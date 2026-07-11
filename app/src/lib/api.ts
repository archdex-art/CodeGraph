// Client-side fetch helpers for the backend API.
import type { AIContext, CodeSymbol, FsEntry, GitBranch, GitLogEntry, GitStatus, Job, RepoDetail, RepoSummary, SaveMode, TrashEntry } from "./types";
import type { RemediationPlan } from "./agents/types";
import type { FixResult } from "./agents/executor-types";

export interface HealthStatus {
  status: string;
  uptime: number;
  ts: number;
  localAccessAllowed: boolean;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) throw new Error("Health check failed");
  return res.json();
}

export interface AuthMe {
  githubAuthEnabled: boolean;
  user: { login: string; name: string | null; avatarUrl: string } | null;
}

export async function fetchMe(): Promise<AuthMe> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to check sign-in state");
  return res.json();
}

export async function signOut(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error("Sign out failed");
}

export interface GithubRepoListing {
  fullName: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
  defaultBranch: string;
  htmlUrl: string;
  language: string | null;
  stargazersCount: number;
}

export async function fetchGithubRepoPage(page: number): Promise<{ repos: GithubRepoListing[]; page: number; hasMore: boolean }> {
  const res = await fetch(`/api/github/repos?page=${page}`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to list GitHub repos");
  return data;
}

export async function startIndex(input: {
  repoUrl?: string;
  localPath?: string;
}): Promise<{ jobId: string; repoId: string }> {
  const res = await fetch("/api/index", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to start indexing");
  return data;
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  home: string;
  entries: BrowseEntry[];
}

export async function browseDir(path?: string): Promise<BrowseResult> {
  const res = await fetch(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`, { cache: "no-store" });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : undefined;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return data as BrowseResult;
}

export async function fetchJob(jobId: string): Promise<Job> {
  const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Job not found");
  return res.json();
}

export async function fetchRepos(): Promise<RepoSummary[]> {
  const res = await fetch("/api/repos", { cache: "no-store" });
  const data = await res.json();
  return data.repos as RepoSummary[];
}

export async function fetchRepo(id: string): Promise<RepoDetail> {
  const res = await fetch(`/api/repos/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Repo not found");
  return res.json();
}

export async function deleteRepo(id: string): Promise<void> {
  const res = await fetch(`/api/repos/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete repository");
  }
}

export async function intelSearch(repoId: string, q: string): Promise<CodeSymbol[]> {
  const res = await fetch(`/api/repos/${repoId}/intel?op=search&q=${encodeURIComponent(q)}`, { cache: "no-store" });
  const d = await res.json();
  return (d.results as CodeSymbol[]) || [];
}

export async function intelRelation(
  repoId: string,
  op: "callers" | "callees" | "members" | "impact",
  symbolId: string
): Promise<CodeSymbol[]> {
  const res = await fetch(`/api/repos/${repoId}/intel?op=${op}&symbol=${encodeURIComponent(symbolId)}`, { cache: "no-store" });
  const d = await res.json();
  return (d.results as CodeSymbol[]) || [];
}

export async function intelContext(repoId: string, q: string): Promise<AIContext> {
  const res = await fetch(`/api/repos/${repoId}/intel?op=context&q=${encodeURIComponent(q)}`, { cache: "no-store" });
  return res.json();
}

export async function intelAudit(
  repoId: string,
  op: "cycles" | "deadcode" | "hubs"
): Promise<{ results?: CodeSymbol[]; cycles?: string[][] }> {
  const res = await fetch(`/api/repos/${repoId}/intel?op=${op}`, { cache: "no-store" });
  return res.json();
}

export async function runAgents(repoId: string): Promise<RemediationPlan> {
  const res = await fetch(`/api/repos/${repoId}/agents`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Agent swarm failed");
  return data as RemediationPlan;
}

export async function runFix(repoId: string, githubToken?: string): Promise<FixResult> {
  const res = await fetch(`/api/repos/${repoId}/fix`, { 
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ githubToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Executor failed");
  return data as FixResult;
}

// --- Built-in editor: filesystem ---

function errorMessage(data: unknown): string | undefined {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return undefined;
}

async function asJson<T>(res: Response): Promise<T> {
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(data) || `Request failed (${res.status})`);
  return data as T;
}

export async function fsList(repoId: string, path = "."): Promise<FsEntry[]> {
  const res = await fetch(`/api/repos/${repoId}/fs?op=list&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  const d = await asJson<{ entries: FsEntry[] }>(res);
  return d.entries;
}

export async function fsRead(repoId: string, path: string): Promise<{ content: string; truncated: boolean; size: number; binary: boolean }> {
  const res = await fetch(`/api/repos/${repoId}/fs?op=read&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  return asJson(res);
}

export async function fsWrite(repoId: string, path: string, content: string): Promise<void> {
  const res = await fetch(`/api/repos/${repoId}/fs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "write", path, content }),
  });
  await asJson(res);
}

export async function fsCreate(repoId: string, path: string, type: "file" | "dir"): Promise<void> {
  const res = await fetch(`/api/repos/${repoId}/fs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "create", path, type }),
  });
  await asJson(res);
}

export async function fsRename(repoId: string, path: string, to: string): Promise<void> {
  const res = await fetch(`/api/repos/${repoId}/fs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "rename", path, to }),
  });
  await asJson(res);
}

export async function fsDuplicate(repoId: string, path: string, to: string): Promise<void> {
  const res = await fetch(`/api/repos/${repoId}/fs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "duplicate", path, to }),
  });
  await asJson(res);
}

export async function fsUpload(repoId: string, path: string, file: File): Promise<void> {
  const buf = await file.arrayBuffer();
  const b64 = btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(""));
  const res = await fetch(`/api/repos/${repoId}/fs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "upload", path, contentBase64: b64 }),
  });
  await asJson(res);
}

export function fsDownloadUrl(repoId: string, path: string): string {
  return `/api/repos/${repoId}/fs?op=download&path=${encodeURIComponent(path)}`;
}

export async function fsDelete(repoId: string, path: string): Promise<TrashEntry> {
  const res = await fetch(`/api/repos/${repoId}/fs?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  const d = await asJson<{ trash: TrashEntry }>(res);
  return d.trash;
}

// --- Built-in editor: trash (restorable deletes) ---

export async function trashList(repoId: string): Promise<TrashEntry[]> {
  const res = await fetch(`/api/repos/${repoId}/trash`, { cache: "no-store" });
  const d = await asJson<{ entries: TrashEntry[] }>(res);
  return d.entries;
}

async function trashPost(repoId: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/repos/${repoId}/trash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await asJson(res);
}

export async function trashRestore(repoId: string, trashId: string): Promise<void> {
  await trashPost(repoId, { op: "restore", trashId });
}

export async function trashPurge(repoId: string, trashId: string): Promise<void> {
  await trashPost(repoId, { op: "purge", trashId });
}

export async function trashEmpty(repoId: string): Promise<void> {
  await trashPost(repoId, { op: "empty" });
}

export async function searchFiles(repoId: string, q: string): Promise<Array<{ file: string; line: number; text: string }>> {
  const res = await fetch(`/api/repos/${repoId}/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
  const d = await asJson<{ results: Array<{ file: string; line: number; text: string }> }>(res);
  return d.results;
}

// --- Built-in editor: git ---

export async function gitStatus(repoId: string): Promise<GitStatus> {
  const res = await fetch(`/api/repos/${repoId}/git?op=status`, { cache: "no-store" });
  return asJson(res);
}

export async function gitBranches(repoId: string): Promise<GitBranch[]> {
  const res = await fetch(`/api/repos/${repoId}/git?op=branches`, { cache: "no-store" });
  const d = await asJson<{ branches: GitBranch[] }>(res);
  return d.branches;
}

export async function gitLog(repoId: string, limit = 30): Promise<GitLogEntry[]> {
  const res = await fetch(`/api/repos/${repoId}/git?op=log&limit=${limit}`, { cache: "no-store" });
  const d = await asJson<{ entries: GitLogEntry[] }>(res);
  return d.entries;
}

export async function gitDiff(repoId: string, path: string): Promise<string> {
  const res = await fetch(`/api/repos/${repoId}/git?op=diff&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  const d = await asJson<{ diff: string }>(res);
  return d.diff;
}

async function gitPost<T>(repoId: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/repos/${repoId}/git`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return asJson<T>(res);
}

export async function gitCommit(repoId: string, message: string): Promise<void> {
  await gitPost(repoId, { op: "commit", message });
}

export async function gitPush(repoId: string, githubToken?: string): Promise<{ output: string }> {
  return gitPost(repoId, { op: "push", githubToken });
}

export async function gitPull(repoId: string): Promise<{ output: string }> {
  return gitPost(repoId, { op: "pull" });
}

export async function gitCheckout(repoId: string, name: string): Promise<void> {
  await gitPost(repoId, { op: "checkout", name });
}

export async function gitCreateBranch(repoId: string, name: string, from?: string): Promise<void> {
  await gitPost(repoId, { op: "createBranch", name, from });
}

export async function getSaveMode(repoId: string): Promise<SaveMode> {
  const res = await fetch(`/api/repos/${repoId}/git?op=saveMode`, { cache: "no-store" });
  const d = await asJson<{ saveMode: SaveMode }>(res);
  return d.saveMode;
}

export async function setSaveMode(repoId: string, mode: SaveMode): Promise<void> {
  await gitPost(repoId, { op: "setSaveMode", saveMode: mode });
}
