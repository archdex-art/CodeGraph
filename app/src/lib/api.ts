// Client-side fetch helpers for the backend API.
import type { AIContext, CodeSymbol, Job, RepoDetail, RepoSummary } from "./types";
import type { RemediationPlan } from "./agents/types";
import type { FixResult } from "./agents/executor-types";

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
