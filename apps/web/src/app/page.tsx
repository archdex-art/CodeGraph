"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight, GitBranch, Loader2, FolderOpen, FolderSearch } from "lucide-react";
import { startIndex, fetchJob, fetchHealth, fetchMe, type AuthMe } from "@/lib/api";
import { FolderBrowser } from "@/components/FolderBrowser";
import { GithubReposPicker } from "@/components/GithubReposPicker";
import { GithubMark } from "@/components/GithubMark";
import type { Job } from "@/lib/types";

const EXAMPLES = [
  "https://github.com/sindresorhus/slugify",
  "https://github.com/expressjs/express",
  "https://github.com/pallets/flask",
];

type Mode = "git" | "local" | "github";

export default function StartPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("git");
  const [url, setUrl] = useState("");
  const [pathVal, setPathVal] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localAccessAllowed, setLocalAccessAllowed] = useState(true); // optimistic; corrected after the health check resolves
  const [me, setMe] = useState<AuthMe | null>(null);
  const busy = job !== null && job.status !== "error";
  const value = mode === "git" ? url : pathVal;

  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setLocalAccessAllowed(h.localAccessAllowed);
        if (!h.localAccessAllowed) setMode((m) => (m === "local" ? "git" : m));
      })
      .catch(() => {}); // health check itself failing isn't this page's concern; leave the optimistic default

    fetchMe()
      .then(setMe)
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    const authError = params.get("authError");
    if (authError) {
      setError(authError);
      const url = new URL(window.location.href);
      url.searchParams.delete("authError");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  async function startWithInput(input: { repoUrl?: string; localPath?: string }) {
    setError(null);
    setJob(null);
    try {
      const { jobId, repoId } = await startIndex(input);
      setRepoId(repoId);
      poll(jobId, repoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await startWithInput(mode === "git" ? { repoUrl: url.trim() } : { localPath: pathVal.trim() });
  }

  function poll(jobId: string, rid: string) {
    const tick = async () => {
      try {
        const j = await fetchJob(jobId);
        setJob(j);
        if (j.status === "done") {
          setTimeout(() => router.push(`/repos/${rid}`), 600);
          return;
        }
        if (j.status === "error") {
          setError(j.error || "Indexing failed");
          return;
        }
        setTimeout(tick, 1000);
      } catch {
        setTimeout(tick, 1500);
      }
    };
    tick();
  }

  return (
    <div className="relative px-6 py-24">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[420px] bg-purple-600/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="max-w-2xl mx-auto relative z-10">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-purple-500/30 bg-purple-500/10 text-purple-300 text-xs font-medium mb-6">
            <GitBranch className="w-3.5 h-3.5" /> Index a repository or folder
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight mb-4">Start Indexing</h1>
          <p className="text-gray-400 mb-8 leading-relaxed">
            CodeGraph builds a knowledge graph across structure, dependencies, and tests, computes a
            Health Score weighted by graph blast radius, and lets you <strong className="text-gray-200">visualize and explore</strong> the codebase.
          </p>
        </motion.div>

        <motion.form
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="rounded-2xl border border-white/10 bg-white/[0.02] p-5"
        >
          {/* Mode toggle */}
          <div className="inline-flex rounded-lg border border-white/10 bg-[#0a0a0a] p-1 mb-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode("git")}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${mode === "git" ? "bg-white text-black" : "text-gray-400 hover:text-white"}`}
            >
              <GitBranch className="w-4 h-4" /> Git URL
            </button>
            <button
              type="button"
              disabled={busy || !localAccessAllowed}
              onClick={() => setMode("local")}
              title={localAccessAllowed ? undefined : "Disabled on this deployment: local-folder indexing would expose the server's filesystem to visitors. Use a Git URL, or self-host with CG_ALLOW_LOCAL_ACCESS=true."}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${mode === "local" ? "bg-white text-black" : "text-gray-400 hover:text-white"} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400`}
            >
              <FolderOpen className="w-4 h-4" /> Local folder
            </button>
            {me?.githubAuthEnabled && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("github")}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${mode === "github" ? "bg-white text-black" : "text-gray-400 hover:text-white"}`}
              >
                <GithubMark className="w-4 h-4" /> My GitHub
              </button>
            )}
          </div>

          {mode !== "github" && (
            <>
              <label className="block text-sm text-gray-400 mb-2">
                {mode === "git" ? "Repository URL" : "Absolute folder path (on the server)"}
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                {mode === "git" ? (
                  <input
                    type="url"
                    required
                    disabled={busy}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="flex-1 rounded-lg bg-[#0a0a0a] border border-white/10 px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50 font-mono disabled:opacity-50"
                  />
                ) : (
                  <div className="flex-1 flex gap-2">
                    <input
                      type="text"
                      required
                      disabled={busy}
                      value={pathVal}
                      onChange={(e) => setPathVal(e.target.value)}
                      placeholder="/Users/you/projects/my-app"
                      className="flex-1 rounded-lg bg-[#0a0a0a] border border-white/10 px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50 font-mono disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setBrowsing(true)}
                      title="Browse for a folder"
                      className="flex items-center gap-2 px-4 py-3 rounded-lg border border-white/10 bg-[#0a0a0a] text-sm text-gray-300 hover:text-white hover:border-purple-500/50 transition-colors disabled:opacity-50 shrink-0"
                    >
                      <FolderSearch className="w-4 h-4" /> Browse
                    </button>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={busy || !value.trim()}
                  className="flex items-center justify-center gap-2 bg-white text-black px-6 py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                  {busy ? "Indexing…" : "Index"}
                </button>
              </div>
            </>
          )}

          {mode === "github" && (
            <div>
              <label className="block text-sm text-gray-400 mb-2">Your repositories</label>
              {!me?.user ? (
                <a
                  href={`/api/auth/github?returnTo=${encodeURIComponent("/")}`}
                  className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-[#0a0a0a] px-4 py-3 text-sm text-gray-300 hover:text-white hover:border-purple-500/50 transition-colors"
                >
                  <GithubMark className="w-4 h-4" /> Sign in with GitHub to browse your repositories
                </a>
              ) : (
                <GithubReposPicker disabled={busy} onSelect={(htmlUrl) => startWithInput({ repoUrl: htmlUrl })} />
              )}
            </div>
          )}

          {mode === "git" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={busy}
                  onClick={() => setUrl(ex)}
                  className="text-xs font-mono text-gray-500 hover:text-purple-300 border border-white/5 hover:border-purple-500/30 rounded px-2 py-1 transition-colors disabled:opacity-40"
                >
                  {ex.replace("https://github.com/", "")}
                </button>
              ))}
            </div>
          )}
          {mode === "local" && (
            <p className="mt-3 text-xs text-gray-600">
              The path must exist on the machine running the app (self-hosted). Nothing is uploaded — it&apos;s read in place.
            </p>
          )}

          {job && (
            <div className="mt-5">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>{job.message}</span>
                <span className="font-mono">{job.progress}%</span>
              </div>
              <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-purple-500 to-blue-500"
                  animate={{ width: `${job.progress}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="mt-4 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2 break-all">
              {error}
            </p>
          )}
        </motion.form>

        {repoId && job?.status === "done" && (
          <p className="mt-4 text-sm text-emerald-400">Done — opening report…</p>
        )}
      </div>

      {browsing && (
        <FolderBrowser
          initialPath={pathVal.trim() || undefined}
          onClose={() => setBrowsing(false)}
          onSelect={(p) => {
            setPathVal(p);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}
