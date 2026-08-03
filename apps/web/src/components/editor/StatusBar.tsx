"use client";

import { GitBranch, Check, Cloud, HardDrive, Loader2 } from "lucide-react";
import type { GitStatus, SaveMode } from "@/lib/types";

export type SaveState = "idle" | "saving" | "saved" | "error";

export function StatusBar({
  gitStatus,
  saveMode,
  saveState,
  language,
  cursor,
  hasGit,
}: {
  gitStatus: GitStatus | null;
  saveMode: SaveMode;
  saveState: SaveState;
  language: string;
  cursor: { line: number; col: number } | null;
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
    <div className="flex items-center justify-between px-md h-6 bg-[var(--violet-500)]/10 border-t border-[var(--line)] text-meta text-[var(--text-primary)] select-none">
      <div className="flex items-center gap-md">
        {hasGit && (
          <span className="flex items-center gap-2xs">
            <GitBranch className="w-3 h-3" /> {gitStatus?.branch || "…"}
          </span>
        )}
        <span className="flex items-center gap-2xs text-[var(--text-secondary)]">
          {hasGit ? <Cloud className="w-3 h-3" /> : <HardDrive className="w-3 h-3" />} {syncLabel}
        </span>
        <span className="text-[var(--text-secondary)]">{saveMode === "local" ? "Local save" : saveMode === "git-auto" ? "Git auto-commit" : "Git manual"}</span>
      </div>
      <div className="flex items-center gap-md">
        {cursor && <span>Ln {cursor.line}, Col {cursor.col}</span>}
        <span>UTF-8</span>
        <span>{language}</span>
        <span className="flex items-center gap-2xs w-16 justify-end">
          {saveState === "saving" && <><Loader2 className="w-3 h-3 animate-spin" /> Saving</>}
          {saveState === "saved" && <><Check className="w-3 h-3 text-[var(--accent-text)]" /> Saved</>}
          {saveState === "error" && <span className="text-[var(--coral-text)]">Save failed</span>}
        </span>
      </div>
    </div>
  );
}
