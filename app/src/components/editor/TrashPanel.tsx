"use client";

import { useEffect, useState } from "react";
import { Trash2, RotateCcw, XCircle, Loader2, File as FileIcon, Folder } from "lucide-react";
import { trashList, trashRestore, trashPurge, trashEmpty } from "@/lib/api";
import type { TrashEntry } from "@/lib/types";

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TrashPanel({ repoId, onMutated }: { repoId: string; onMutated: () => void }) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setEntries(await trashList(repoId));
    } catch {
      setEntries([]);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  async function restore(entry: TrashEntry) {
    setBusyId(entry.id);
    try {
      await trashRestore(repoId, entry.id);
      await load();
      onMutated();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusyId(null);
    }
  }

  async function purge(entry: TrashEntry) {
    if (!confirm(`Permanently delete "${entry.path}"? This cannot be undone.`)) return;
    setBusyId(entry.id);
    try {
      await trashPurge(repoId, entry.id);
      await load();
      onMutated();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  async function empty() {
    if (!entries || entries.length === 0) return;
    if (!confirm(`Permanently delete all ${entries.length} item(s) in Trash? This cannot be undone.`)) return;
    try {
      await trashEmpty(repoId);
      await load();
      onMutated();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Empty trash failed");
    }
  }

  if (entries === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 p-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading trash…
      </div>
    );
  }

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
        <span>Trash</span>
        <button
          onClick={empty}
          disabled={entries.length === 0}
          title="Empty Trash"
          className="p-1 rounded hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="px-3 py-4 text-xs text-gray-600">Trash is empty. Deleted files show up here and can be restored.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-white/5">
              {entry.type === "dir" ? (
                <Folder className="w-3.5 h-3.5 text-gray-500 shrink-0" />
              ) : (
                <FileIcon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs text-gray-300" title={entry.path}>{entry.name}</div>
                <div className="truncate text-[10px] text-gray-600">
                  {entry.path} · {formatSize(entry.size)} · {timeAgo(entry.deletedAt)}
                </div>
              </div>
              {busyId === entry.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500 shrink-0" />
              ) : (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                  <button onClick={() => restore(entry)} title="Restore" className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-emerald-400">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => purge(entry)} title="Delete forever" className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-rose-400">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
