"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, FolderGit2, Network, Trash2 } from "lucide-react";
import { fetchRepos, deleteRepo } from "@/lib/api";
import type { RepoSummary } from "@/lib/types";

function scoreColor(s: number | null): string {
  if (s === null) return "text-gray-500";
  if (s >= 80) return "text-emerald-400";
  if (s >= 60) return "text-amber-400";
  return "text-rose-400";
}

export default function DashboardPage() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Remove "${name}" from CodeGraph? This deletes its index and cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await deleteRepo(id);
      setRepos((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete repository");
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetchRepos();
        if (active) setRepos(r);
      } catch {
        if (active) setRepos([]);
      }
    };
    load();
    const iv = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Indexed repositories and their Health Scores.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/fleet"
            className="flex items-center gap-2 bg-white/[0.05] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-white/[0.1] transition-colors"
          >
            <Network className="w-4 h-4 text-cyan-400" /> Fleet Graph
          </Link>
          <Link
            href="/"
            className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-200 transition-colors"
          >
            Index a repo <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {repos === null ? (
        <div className="flex items-center gap-2 text-gray-500 py-20 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : repos.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-white/10 rounded-2xl">
          <FolderGit2 className="w-8 h-8 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No repositories indexed yet.</p>
          <Link href="/" className="text-purple-400 hover:text-purple-300 text-sm mt-2 inline-block">
            Start indexing →
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {repos.map((r) => {
            const processing = r.status !== "done" && r.status !== "error";
            const inner = (
              <div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] px-5 py-4 hover:bg-white/[0.04] transition-colors">
                <div className="min-w-0">
                  <div className="font-semibold text-white truncate flex items-center gap-2">
                    {r.name}
                    <span className="text-[10px] font-normal text-gray-500 border border-white/10 rounded px-1 py-0.5">{r.sourceType}</span>
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">{r.url}</div>
                </div>
                <div className="flex items-center gap-5 shrink-0 ml-4">
                  {processing ? (
                    <span className="flex items-center gap-2 text-xs text-purple-300">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> {r.status}
                    </span>
                  ) : r.status === "error" ? (
                    <span className="text-xs text-rose-400">error</span>
                  ) : (
                    <div className="text-right">
                      <div className={`text-2xl font-bold ${scoreColor(r.score)}`}>{r.score}</div>
                      <div className="text-[10px] text-gray-600 uppercase tracking-wide">health</div>
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${r.name}`}
                    title="Remove repository"
                    disabled={deletingId === r.id}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDelete(r.id, r.name);
                    }}
                    className="p-2 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors disabled:opacity-50"
                  >
                    {deletingId === r.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            );
            return r.status === "done" ? (
              <Link key={r.id} href={`/repos/${r.id}`}>{inner}</Link>
            ) : (
              <div key={r.id}>{inner}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
