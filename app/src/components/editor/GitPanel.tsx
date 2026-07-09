"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GitBranch, GitCommit, ArrowUp, ArrowDown, Loader2, Plus, RefreshCw,
  FileEdit, FilePlus, FileMinus, FileQuestion, AlertTriangle, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  gitStatus, gitBranches, gitLog, gitDiff, gitCommit, gitPush, gitPull, gitCheckout, gitCreateBranch,
} from "@/lib/api";
import type { GitBranch as Branch, GitLogEntry, GitStatus, GitStatusEntry, SaveMode } from "@/lib/types";

const STATUS_META: Record<GitStatusEntry["status"], { icon: React.ReactNode; color: string; letter: string }> = {
  modified: { icon: <FileEdit className="w-3.5 h-3.5" />, color: "text-amber-400", letter: "M" },
  added: { icon: <FilePlus className="w-3.5 h-3.5" />, color: "text-emerald-400", letter: "A" },
  deleted: { icon: <FileMinus className="w-3.5 h-3.5" />, color: "text-rose-400", letter: "D" },
  untracked: { icon: <FileQuestion className="w-3.5 h-3.5" />, color: "text-gray-400", letter: "U" },
  renamed: { icon: <FileEdit className="w-3.5 h-3.5" />, color: "text-sky-400", letter: "R" },
  conflicted: { icon: <AlertTriangle className="w-3.5 h-3.5" />, color: "text-rose-500", letter: "!" },
};

export function GitPanel({
  repoId,
  saveMode,
  onSaveModeChange,
  autoPush,
  onAutoPushChange,
  commitTemplate,
  onCommitTemplateChange,
  refreshToken,
  onMutated,
  onOpenDiff,
}: {
  repoId: string;
  saveMode: SaveMode;
  onSaveModeChange: (m: SaveMode) => void;
  autoPush: boolean;
  onAutoPushChange: (v: boolean) => void;
  commitTemplate: string;
  onCommitTemplateChange: (v: string) => void;
  refreshToken: number;
  onMutated: () => void;
  onOpenDiff: (path: string, diff: string) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notARepo, setNotARepo] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [logOpen, setLogOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([gitStatus(repoId), gitBranches(repoId)]);
      setStatus(s);
      setBranches(b);
      setNotARepo(false);
    } catch {
      setNotARepo(true);
      setStatus(null);
    }
  }, [repoId]);

  useEffect(() => { refresh(); }, [refresh, refreshToken]);
  useEffect(() => {
    if (logOpen) gitLog(repoId, 30).then(setLog).catch(() => setLog([]));
  }, [logOpen, repoId, refreshToken]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Git operation failed");
    } finally {
      setBusy(null);
    }
  }

  const doCommit = () => run("commit", async () => {
    if (!message.trim()) throw new Error("Commit message required");
    await gitCommit(repoId, message.trim());
    setMessage("");
  });

  const doPush = () => run("push", async () => {
    await gitPush(repoId, token.trim() || undefined);
  });

  const doCommitAndPush = () => run("commit+push", async () => {
    if (message.trim()) {
      await gitCommit(repoId, message.trim());
      setMessage("");
    }
    await gitPush(repoId, token.trim() || undefined);
  });

  const doPull = () => run("pull", async () => {
    await gitPull(repoId);
  });

  const doCheckout = (name: string) => run("checkout", async () => {
    await gitCheckout(repoId, name.replace(/^origin\//, ""));
  });

  const doCreateBranch = () => run("branch", async () => {
    if (!newBranchName.trim()) throw new Error("Branch name required");
    await gitCreateBranch(repoId, newBranchName.trim());
    setNewBranchName("");
    setNewBranchOpen(false);
  });

  async function showDiff(entry: GitStatusEntry) {
    try {
      const diff = await gitDiff(repoId, entry.path);
      onOpenDiff(entry.path, diff || `No diff available for ${entry.status} file "${entry.path}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load diff");
    }
  }

  if (notARepo) {
    return (
      <div className="p-3 text-xs text-gray-500 space-y-2">
        <p>This workspace is not a Git repository (local folder). Git sync is unavailable — use “Save locally”.</p>
        <button onClick={refresh} className="flex items-center gap-1 text-gray-400 hover:text-white">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
    );
  }

  const hasConflicts = status?.entries.some((e) => e.status === "conflicted");

  return (
    <div className="text-xs">
      {/* Save mode */}
      <div className="px-3 pt-3 pb-2 space-y-2 border-b border-white/5">
        <div className="text-[11px] uppercase tracking-wide text-gray-500">Save Mode</div>
        <select
          value={saveMode}
          onChange={(e) => onSaveModeChange(e.target.value as SaveMode)}
          className="w-full bg-[#0a0a0a] border border-white/10 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-purple-500/50"
        >
          <option value="local">Save locally only</option>
          <option value="git-manual">Save to Git — manual commit</option>
          <option value="git-auto">Save to Git — auto-commit</option>
        </select>
        {saveMode === "git-auto" && (
          <>
            <label className="flex items-center gap-2 text-gray-400">
              <input type="checkbox" checked={autoPush} onChange={(e) => onAutoPushChange(e.target.checked)} />
              Auto-push after commit
            </label>
            <input
              value={commitTemplate}
              onChange={(e) => onCommitTemplateChange(e.target.value)}
              placeholder="Commit message template — {file}, {time}"
              className="w-full bg-[#0a0a0a] border border-white/10 rounded px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
            />
          </>
        )}
      </div>

      {/* Branch */}
      <div className="px-3 py-2.5 border-b border-white/5 space-y-1.5">
        <div className="flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <select
            value={status?.branch || ""}
            onChange={(e) => doCheckout(e.target.value)}
            className="flex-1 bg-transparent text-white font-medium focus:outline-none"
          >
            {status?.branch && !branches.some((b) => b.name === status.branch) && (
              <option value={status.branch}>{status.branch}</option>
            )}
            {branches.map((b) => (
              <option key={b.name} value={b.name} className="bg-[#0a0a0a]">{b.name}{b.remote ? " (remote)" : ""}</option>
            ))}
          </select>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="flex items-center gap-1 text-gray-500 shrink-0">
              {status.ahead > 0 && <span className="flex items-center"><ArrowUp className="w-3 h-3" />{status.ahead}</span>}
              {status.behind > 0 && <span className="flex items-center"><ArrowDown className="w-3 h-3" />{status.behind}</span>}
            </span>
          )}
        </div>
        {!newBranchOpen ? (
          <button onClick={() => setNewBranchOpen(true)} className="flex items-center gap-1 text-gray-500 hover:text-white">
            <Plus className="w-3 h-3" /> New branch
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doCreateBranch(); if (e.key === "Escape") setNewBranchOpen(false); }}
              placeholder="feature/my-branch"
              className="flex-1 bg-[#0a0a0a] border border-white/10 rounded px-2 py-1 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
            />
            <button onClick={doCreateBranch} className="text-emerald-400 hover:text-emerald-300 px-1">Create</button>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button onClick={doPull} disabled={!!busy} className="flex-1 flex items-center justify-center gap-1 border border-white/10 rounded px-2 py-1.5 text-gray-300 hover:bg-white/5 disabled:opacity-40">
            {busy === "pull" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowDown className="w-3 h-3" />} Pull
          </button>
          <button onClick={doPush} disabled={!!busy} className="flex-1 flex items-center justify-center gap-1 border border-white/10 rounded px-2 py-1.5 text-gray-300 hover:bg-white/5 disabled:opacity-40">
            {busy === "push" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />} Push
          </button>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="GitHub PAT for push (optional)"
          className="w-full bg-[#0a0a0a] border border-white/10 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
        />
      </div>

      {hasConflicts && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>Merge conflicts detected. Open the flagged file(s), resolve the {"<<<<<<< / ======= / >>>>>>>"} markers manually, then commit.</span>
        </div>
      )}
      {error && <p className="mx-3 mt-2 text-rose-400">{error}</p>}

      {/* Status entries */}
      <div className="px-3 py-2.5 border-b border-white/5">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">
          Changes {status && status.entries.length > 0 ? `(${status.entries.length})` : ""}
        </div>
        {status && status.entries.length === 0 && <p className="text-gray-600">Working tree clean.</p>}
        <div className="space-y-0.5 max-h-56 overflow-auto">
          {status?.entries.map((e) => {
            const meta = STATUS_META[e.status];
            return (
              <button
                key={e.path}
                onClick={() => showDiff(e)}
                className="flex items-center gap-2 w-full text-left px-1.5 py-1 rounded hover:bg-white/5"
              >
                <span className={meta.color}>{meta.icon}</span>
                <span className="truncate flex-1 text-gray-300">{e.path}</span>
                <span className={`${meta.color} font-mono`}>{meta.letter}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Commit */}
      <div className="px-3 py-2.5 border-b border-white/5 space-y-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          rows={3}
          className="w-full bg-[#0a0a0a] border border-white/10 rounded px-2 py-1.5 text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-purple-500/50"
        />
        <div className="flex gap-2">
          <button onClick={doCommit} disabled={!!busy || !status || status.entries.length === 0} className="flex-1 flex items-center justify-center gap-1 bg-white text-black rounded px-2 py-1.5 font-medium hover:bg-gray-200 disabled:opacity-30">
            {busy === "commit" ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitCommit className="w-3 h-3" />} Commit
          </button>
          <button onClick={doCommitAndPush} disabled={!!busy} className="flex-1 flex items-center justify-center gap-1 border border-emerald-500/30 text-emerald-300 rounded px-2 py-1.5 font-medium hover:bg-emerald-500/10 disabled:opacity-30">
            {busy === "commit+push" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />} Commit &amp; Push
          </button>
        </div>
      </div>

      {/* Log */}
      <div className="px-3 py-2.5">
        <button onClick={() => setLogOpen((v) => !v)} className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-gray-500 hover:text-gray-300">
          {logOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} History
        </button>
        {logOpen && (
          <div className="mt-1.5 space-y-2 max-h-64 overflow-auto">
            {log.length === 0 && <p className="text-gray-600">No commits yet.</p>}
            {log.map((c) => (
              <div key={c.hash} className="border-l-2 border-white/10 pl-2">
                <p className="text-gray-200 truncate">{c.message}</p>
                <p className="text-gray-600">{c.author} · {new Date(c.date).toLocaleString()} · <span className="font-mono">{c.hash.slice(0, 7)}</span></p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
