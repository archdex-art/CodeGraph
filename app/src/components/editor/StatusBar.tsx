"use client";

import { GitBranch, Check, Cloud, HardDrive, Loader2, Sun, Moon } from "lucide-react";
import type { GitStatus, SaveMode } from "@/lib/types";

export type SaveState = "idle" | "saving" | "saved" | "error";

export function StatusBar({
  gitStatus,
  saveMode,
  saveState,
  language,
  cursor,
  theme,
  onToggleTheme,
  hasGit,
}: {
  gitStatus: GitStatus | null;
  saveMode: SaveMode;
  saveState: SaveState;
  language: string;
  cursor: { line: number; col: number } | null;
  theme: "vs-dark" | "light";
  onToggleTheme: () => void;
  hasGit: boolean;
}) {
  const syncLabel = !hasGit
    ? "Local folder"
    : !gitStatus
    ? "…"
    : gitStatus.ahead === 0 && gitStatus.behind === 0
    ? "Synced"
    : `${gitStatus.ahead > 0 ? `↑${gitStatus.ahead} ` : ""}${gitStatus.behind > 0 ? `↓${gitStatus.behind}` : ""}`.trim();

  return (
    <div className="flex items-center justify-between px-3 h-6 bg-[#8b5cf6]/10 border-t border-white/10 text-[11px] text-gray-300 select-none">
      <div className="flex items-center gap-3">
        {hasGit && (
          <span className="flex items-center gap-1">
            <GitBranch className="w-3 h-3" /> {gitStatus?.branch || "…"}
          </span>
        )}
        <span className="flex items-center gap-1 text-gray-400">
          {hasGit ? <Cloud className="w-3 h-3" /> : <HardDrive className="w-3 h-3" />} {syncLabel}
        </span>
        <span className="text-gray-500">{saveMode === "local" ? "Local save" : saveMode === "git-auto" ? "Git auto-commit" : "Git manual"}</span>
      </div>
      <div className="flex items-center gap-3">
        {cursor && <span>Ln {cursor.line}, Col {cursor.col}</span>}
        <span>UTF-8</span>
        <span>{language}</span>
        <button onClick={onToggleTheme} className="flex items-center gap-1 hover:text-white" title="Toggle editor theme">
          {theme === "vs-dark" ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
        </button>
        <span className="flex items-center gap-1 w-16 justify-end">
          {saveState === "saving" && <><Loader2 className="w-3 h-3 animate-spin" /> Saving</>}
          {saveState === "saved" && <><Check className="w-3 h-3 text-emerald-400" /> Saved</>}
          {saveState === "error" && <span className="text-rose-400">Save failed</span>}
        </span>
      </div>
    </div>
  );
}
