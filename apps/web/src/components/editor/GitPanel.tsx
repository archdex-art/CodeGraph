"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitBranch, GitCommit, ArrowUp, ArrowDown, Loader2, Plus, RefreshCw, Undo2,
  FileEdit, FilePlus, FileMinus, FileQuestion, AlertTriangle, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  gitStatus, gitBranches, gitLog, gitDiff, gitCommit, gitPush, gitPull, gitCheckout, gitCreateBranch, gitRestoreFile,
} from "@/lib/api";
import type { GitBranch as Branch, GitLogEntry, GitStatus, GitStatusEntry, SaveMode } from "@/lib/types";

const STATUS_META: Record<GitStatusEntry["status"], { icon: React.ReactNode; color: string; letter: string }> = {
  modified: { icon: <FileEdit className="w-3.5 h-3.5" />, color: "text-[var(--amber-text)]", letter: "M" },
  added: { icon: <FilePlus className="w-3.5 h-3.5" />, color: "text-[var(--accent-text)]", letter: "A" },
  deleted: { icon: <FileMinus className="w-3.5 h-3.5" />, color: "text-[var(--coral-text)]", letter: "D" },
  untracked: { icon: <FileQuestion className="w-3.5 h-3.5" />, color: "text-[var(--text-secondary)]", letter: "U" },
  renamed: { icon: <FileEdit className="w-3.5 h-3.5" />, color: "text-[var(--violet-text)]", letter: "R" },
  conflicted: { icon: <AlertTriangle className="w-3.5 h-3.5" />, color: "text-[var(--coral-text)]", letter: "!" },
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

  // `refresh()` fires both from the refreshToken effect (every editor save) and
  // from `run()` after every git mutation, so two can be in flight at once and
  // git latency decides which lands last. Newest request wins.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const [s, b] = await Promise.all([gitStatus(repoId), gitBranches(repoId)]);
      if (seq !== refreshSeq.current) return;
      setStatus(s);
      setBranches(b);
      setNotARepo(false);
    } catch {
      if (seq !== refreshSeq.current) return;
      setNotARepo(true);
      setStatus(null);
    }
  }, [repoId]);

  useEffect(() => { refresh(); }, [refresh, refreshToken]);

  useEffect(() => {
    if (!logOpen) return;
    let active = true;
    gitLog(repoId, 30)
      .then((l) => { if (active) setLog(l); })
      .catch(() => { if (active) setLog([]); });
    return () => { active = false; };
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

  async function revertFile(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to revert changes to ${path}?`)) return;
    await run("Reverting", async () => {
      await gitRestoreFile(repoId, path);
      onMutated();
    });
  }

  if (notARepo) {
    return (
      <div className="p-md text-meta text-[var(--text-secondary)] space-y-sm">
        <p>This workspace is not a Git repository (local folder). Git sync is unavailable — use “Save locally”.</p>
        <button onClick={refresh} className="flex items-center gap-2xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
    );
  }

  const hasConflicts = status?.entries.some((e) => e.status === "conflicted");

  return (
    <div className="text-meta">
      {/* Save mode */}
      <div className="px-md pt-md pb-sm space-y-sm border-b border-[var(--line-soft)]">
        <div className="text-meta uppercase tracking-wide text-[var(--text-secondary)]">Save Mode</div>
        <select
          value={saveMode}
          onChange={(e) => onSaveModeChange(e.target.value as SaveMode)}
          className="w-full bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--violet-500)]/50"
        >
          <option value="local">Save locally only</option>
          <option value="git-manual">Save to Git — manual commit</option>
          <option value="git-auto">Save to Git — auto-commit</option>
        </select>
        {saveMode === "git-auto" && (
          <>
            <label className="flex items-center gap-sm text-[var(--text-secondary)]">
              <input type="checkbox" checked={autoPush} onChange={(e) => onAutoPushChange(e.target.checked)} />
              Auto-push after commit
            </label>
            <input
              value={commitTemplate}
              onChange={(e) => onCommitTemplateChange(e.target.value)}
              placeholder="Commit message template — {file}, {time}"
              className="w-full bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--violet-500)]/50"
            />
          </>
        )}
      </div>

      {/* Branch */}
      <div className="px-md py-sm border-b border-[var(--line-soft)] space-y-xs">
        <div className="flex items-center gap-sm">
          <GitBranch className="w-3.5 h-3.5 text-[var(--violet-text)] shrink-0" />
          <select
            value={status?.branch || ""}
            onChange={(e) => doCheckout(e.target.value)}
            className="flex-1 bg-transparent text-[var(--text-primary)] font-medium focus:outline-none"
          >
            {status?.branch && !branches.some((b) => b.name === status.branch) && (
              <option value={status.branch}>{status.branch}</option>
            )}
            {branches.map((b) => (
              <option key={b.name} value={b.name} className="bg-[var(--surface-2)]">{b.name}{b.remote ? " (remote)" : ""}</option>
            ))}
          </select>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="flex items-center gap-2xs text-[var(--text-secondary)] shrink-0">
              {status.ahead > 0 && <span className="flex items-center"><ArrowUp className="w-3 h-3" />{status.ahead}</span>}
              {status.behind > 0 && <span className="flex items-center"><ArrowDown className="w-3 h-3" />{status.behind}</span>}
            </span>
          )}
        </div>
        {!newBranchOpen ? (
          <button onClick={() => setNewBranchOpen(true)} className="flex items-center gap-2xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <Plus className="w-3 h-3" /> New branch
          </button>
        ) : (
          <div className="flex items-center gap-2xs">
            <input
              autoFocus
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doCreateBranch(); if (e.key === "Escape") setNewBranchOpen(false); }}
              placeholder="feature/my-branch"
              className="flex-1 bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-2xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--violet-500)]/50"
            />
            <button onClick={doCreateBranch} className="text-[var(--accent-text)] hover:text-[var(--accent-text)] px-2xs">Create</button>
          </div>
        )}
        <div className="flex gap-sm pt-2xs">
          <button onClick={doPull} disabled={!!busy} className="flex-1 flex items-center justify-center gap-2xs border border-[var(--line)] rounded-xs px-sm py-xs text-[var(--text-primary)] hover:bg-[var(--surface-active)] disabled:opacity-40">
            {busy === "pull" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowDown className="w-3 h-3" />} Pull
          </button>
          <button onClick={doPush} disabled={!!busy} className="flex-1 flex items-center justify-center gap-2xs border border-[var(--line)] rounded-xs px-sm py-xs text-[var(--text-primary)] hover:bg-[var(--surface-active)] disabled:opacity-40">
            {busy === "push" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />} Push
          </button>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="GitHub PAT for push (optional)"
          className="w-full bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-2xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--violet-500)]/50"
        />
      </div>

      {hasConflicts && (
        <div className="mx-md mt-sm flex items-start gap-sm rounded-xs border border-[var(--coral-500)]/30 bg-[var(--coral-500)]/10 p-sm text-[var(--coral-text)]">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-2xs" />
          <span>Merge conflicts detected. Open the flagged file(s), resolve the {"<<<<<<< / ======= / >>>>>>>"} markers manually, then commit.</span>
        </div>
      )}
      {error && <p className="mx-md mt-sm text-[var(--coral-text)]">{error}</p>}

      {/* Status entries */}
      <div className="px-md py-sm border-b border-[var(--line-soft)]">
        <div className="text-meta uppercase tracking-wide text-[var(--text-secondary)] mb-xs">
          Changes {status && status.entries.length > 0 ? `(${status.entries.length})` : ""}
        </div>
        {status && status.entries.length === 0 && <p className="text-[var(--text-muted)]">Working tree clean.</p>}
        <div className="space-y-2xs max-h-56 overflow-auto">
          {status?.entries.map((e) => {
            const meta = STATUS_META[e.status];
            return (
              <div
                key={e.path}
                className="group flex items-center gap-sm w-full text-left px-xs py-2xs rounded-xs hover:bg-[var(--surface-active)] cursor-pointer"
                onClick={() => showDiff(e)}
              >
                <span className={meta.color}>{meta.icon}</span>
                <span className="truncate flex-1 text-[var(--text-primary)]">{e.path}</span>
                <button
                  onClick={(evt) => revertFile(evt, e.path)}
                  title="Revert changes"
                  className="opacity-0 group-hover:opacity-100 p-2xs rounded-xs hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] text-[var(--text-secondary)]"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                </button>
                <span className={`${meta.color} font-mono ml-2xs`}>{meta.letter}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Commit */}
      <div className="px-md py-sm border-b border-[var(--line-soft)] space-y-sm">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          rows={3}
          className="w-full bg-[var(--surface-2)] border border-[var(--line)] rounded-xs px-sm py-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none focus:outline-none focus:border-[var(--violet-500)]/50"
        />
        <div className="flex gap-sm">
          <button onClick={doCommit} disabled={!!busy || !status || status.entries.length === 0} className="flex-1 flex items-center justify-center gap-2xs bg-[var(--accent-fill)] text-[var(--accent-on-fill)] rounded-xs px-sm py-xs font-medium hover:bg-[var(--signal-400)] disabled:opacity-30">
            {busy === "commit" ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitCommit className="w-3 h-3" />} Commit
          </button>
          <button onClick={doCommitAndPush} disabled={!!busy} className="flex-1 flex items-center justify-center gap-2xs border border-[var(--signal-500)]/30 text-[var(--accent-text)] rounded-xs px-sm py-xs font-medium hover:bg-[var(--signal-500)]/10 disabled:opacity-30">
            {busy === "commit+push" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />} Commit &amp; Push
          </button>
        </div>
      </div>

      {/* Log */}
      <div className="px-md py-sm">
        <button onClick={() => setLogOpen((v) => !v)} className="flex items-center gap-2xs text-meta uppercase tracking-wide text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          {logOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} History
        </button>
        {logOpen && (
          <div className="mt-xs space-y-sm max-h-64 overflow-auto">
            {log.length === 0 && <p className="text-[var(--text-muted)]">No commits yet.</p>}
            {log.map((c) => (
              <div key={c.hash} className="border-l-2 border-[var(--line)] pl-sm">
                <p className="text-[var(--text-primary)] truncate">{c.message}</p>
                <p className="text-[var(--text-muted)]">{c.author} · {new Date(c.date).toLocaleString()} · <span className="font-mono">{c.hash.slice(0, 7)}</span></p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
