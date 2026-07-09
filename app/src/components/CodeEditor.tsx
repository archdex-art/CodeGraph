"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { OnMount } from "@monaco-editor/react";
import {
  FolderTree, Search as SearchIcon, GitBranch as GitBranchIcon, X, Save, Circle,
} from "lucide-react";
import { FileExplorer } from "./editor/FileExplorer";
import { GitPanel } from "./editor/GitPanel";
import { SearchPanel } from "./editor/SearchPanel";
import { StatusBar, type SaveState } from "./editor/StatusBar";
import { fsRead, fsWrite, gitStatus as fetchGitStatus, gitCommit, gitPush, getSaveMode, setSaveMode as persistSaveMode } from "@/lib/api";
import { languageForPath } from "@/lib/editorLang";
import type { GitStatus, RepoDetail, SaveMode } from "@/lib/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), { ssr: false });

type Panel = "explorer" | "search" | "git";

interface Tab {
  path: string;
  content: string;
  original: string;
  dirty: boolean;
}

interface PersistedState {
  openTabs: string[];
  activeTab: string | null;
  theme: "vs-dark" | "light";
  autoSave: boolean;
  autoPush: boolean;
  commitTemplate: string;
}

const DEFAULT_TEMPLATE = "Update {file} via CodeGraph Editor";

function storageKey(repoId: string) {
  return `cg-editor-state:${repoId}`;
}

function loadPersisted(repoId: string): PersistedState {
  const fallback: PersistedState = {
    openTabs: [], activeTab: null, theme: "vs-dark", autoSave: false, autoPush: false, commitTemplate: DEFAULT_TEMPLATE,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey(repoId));
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function CodeEditor({ repo, visible = true }: { repo: RepoDetail; visible?: boolean }) {
  const repoId = repo.id;
  const persisted = useMemo(() => loadPersisted(repoId), [repoId]);

  const [panel, setPanel] = useState<Panel>("explorer");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [theme, setTheme] = useState<"vs-dark" | "light">(persisted.theme);
  const [autoSave, setAutoSave] = useState(persisted.autoSave);
  const [autoPush, setAutoPush] = useState(persisted.autoPush);
  const [commitTemplate, setCommitTemplate] = useState(persisted.commitTemplate);
  const [saveMode, setSaveModeState] = useState<SaveMode>("local");
  const [pushToken, setPushToken] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [gitStat, setGitStat] = useState<GitStatus | null>(null);
  const [diffModal, setDiffModal] = useState<{ path: string; diff: string } | null>(null);
  const [pendingReveal, setPendingReveal] = useState<number | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const restoredRef = useRef(false);

  const hasGit = repo.sourceType === "git";

  // Restore save mode from server + tabs from localStorage, once per repo.
  useEffect(() => {
    restoredRef.current = false;
    getSaveMode(repoId).then(setSaveModeState).catch(() => {});
    (async () => {
      const st = loadPersisted(repoId);
      const restoredTabs: Tab[] = [];
      for (const p of st.openTabs) {
        try {
          const { content, binary } = await fsRead(repoId, p);
          if (!binary) restoredTabs.push({ path: p, content, original: content, dirty: false });
        } catch { /* file gone, skip */ }
      }
      setTabs(restoredTabs);
      setActivePath(st.activeTab && restoredTabs.some((t) => t.path === st.activeTab) ? st.activeTab : restoredTabs[0]?.path ?? null);
      restoredRef.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // Persist lightweight UI state across sessions.
  useEffect(() => {
    if (!restoredRef.current) return;
    const state: PersistedState = {
      openTabs: tabs.map((t) => t.path), activeTab: activePath, theme, autoSave, autoPush, commitTemplate,
    };
    window.localStorage.setItem(storageKey(repoId), JSON.stringify(state));
  }, [repoId, tabs, activePath, theme, autoSave, autoPush, commitTemplate]);

  const refreshGitStatus = useCallback(() => {
    if (!hasGit) return;
    fetchGitStatus(repoId).then(setGitStat).catch(() => setGitStat(null));
  }, [repoId, hasGit]);

  useEffect(() => { refreshGitStatus(); }, [refreshGitStatus, refreshToken]);

  // Warn on tab close / navigation with unsaved work.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (tabs.some((t) => t.dirty)) { e.preventDefault(); }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tabs]);

  const activeTab = tabs.find((t) => t.path === activePath) || null;

  const openFile = useCallback(async (path: string) => {
    const existing = tabs.find((t) => t.path === path);
    if (existing) { setActivePath(path); return; }
    setLoadingPath(path);
    try {
      const { content, binary, truncated } = await fsRead(repoId, path);
      if (binary) {
        alert("This file appears to be binary and cannot be edited here. Use Download instead.");
        return;
      }
      if (truncated) {
        // still open — best effort — flag to user
        console.warn(`File ${path} truncated for editing (exceeds size cap).`);
      }
      setTabs((prev) => [...prev, { path, content, original: content, dirty: false }]);
      setActivePath(path);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to open file");
    } finally {
      setLoadingPath(null);
    }
  }, [repoId, tabs]);

  const openAtLine = useCallback(async (path: string, line: number) => {
    await openFile(path);
    setActivePath(path);
    setPendingReveal(line);
  }, [openFile]);

  function closeTab(path: string, force = false) {
    const t = tabs.find((x) => x.path === path);
    if (t?.dirty && !force) {
      if (!confirm(`"${path}" has unsaved changes. Close without saving?`)) return;
    }
    setTabs((prev) => prev.filter((x) => x.path !== path));
    if (activePath === path) {
      const idx = tabs.findIndex((x) => x.path === path);
      const next = tabs[idx + 1] || tabs[idx - 1];
      setActivePath(next?.path ?? null);
    }
  }

  function onDeletedFromExplorer(path: string) {
    setTabs((prev) => prev.filter((x) => x.path !== path && !x.path.startsWith(path + "/")));
    if (activePath === path || activePath?.startsWith(path + "/")) setActivePath(null);
    setRefreshToken((n) => n + 1);
  }

  function updateContent(path: string, content: string) {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, content, dirty: content !== t.original } : t)));
  }

  const saveTab = useCallback(async (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    setSaveState("saving");
    try {
      await fsWrite(repoId, path, tab.content);
      if (saveMode === "git-auto" && hasGit) {
        const msg = commitTemplate.replace("{file}", path).replace("{time}", new Date().toISOString());
        try {
          await gitCommit(repoId, msg);
          if (autoPush) await gitPush(repoId, pushToken.trim() || undefined);
        } catch (e) {
          // Commit/push failure shouldn't hide that the file itself saved fine.
          console.warn("Auto-commit/push failed:", e);
        }
      }
      setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, original: tab.content, dirty: false } : t)));
      setSaveState("saved");
      setRefreshToken((n) => n + 1);
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch (e) {
      setSaveState("error");
      alert(e instanceof Error ? e.message : "Save failed");
    }
  }, [tabs, repoId, saveMode, hasGit, commitTemplate, autoPush, pushToken]);

  // Ctrl/Cmd+S saves the active tab regardless of focus target.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activePath) saveTab(activePath);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePath, saveTab]);

  // Debounced autosave.
  useEffect(() => {
    if (!autoSave || !activeTab?.dirty) return;
    const t = setTimeout(() => saveTab(activeTab.path), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, activeTab?.content]);

  function handleSaveModeChange(m: SaveMode) {
    setSaveModeState(m);
    persistSaveMode(repoId, m).catch(() => {});
  }

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }));
  };

  useEffect(() => {
    if (pendingReveal != null && editorRef.current) {
      editorRef.current.revealLineInCenter(pendingReveal);
      editorRef.current.setPosition({ lineNumber: pendingReveal, column: 1 });
      editorRef.current.focus();
      setPendingReveal(null);
    }
  }, [pendingReveal, activePath]);

  // The parent page keeps this component mounted (hidden via CSS) when its tab
  // isn't active, to preserve open tabs/scroll/undo state. Monaco lays itself
  // out against a zero-size hidden container though, so force a re-layout the
  // moment the tab becomes visible again.
  useEffect(() => {
    if (visible) editorRef.current?.layout();
  }, [visible]);

  const dirtyPaths = useMemo(() => new Set(tabs.filter((t) => t.dirty).map((t) => t.path)), [tabs]);
  const lang = activePath ? languageForPath(activePath) : { id: "plaintext", label: "Plain Text" };

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0a0a0b] overflow-hidden flex flex-col" style={{ height: "78vh" }}>
      <div className="flex flex-1 min-h-0">
        {/* Activity bar */}
        <div className="w-12 border-r border-white/10 flex flex-col items-center py-2 gap-1 bg-black/20 shrink-0">
          <ActivityBtn active={panel === "explorer"} onClick={() => setPanel("explorer")} icon={<FolderTree className="w-4.5 h-4.5" />} title="Explorer" />
          <ActivityBtn active={panel === "search"} onClick={() => setPanel("search")} icon={<SearchIcon className="w-4.5 h-4.5" />} title="Search" />
          {hasGit && (
            <ActivityBtn active={panel === "git"} onClick={() => setPanel("git")} icon={<GitBranchIcon className="w-4.5 h-4.5" />} title="Source Control" badge={gitStat && gitStat.entries.length > 0 ? gitStat.entries.length : undefined} />
          )}
        </div>

        {/* Side panel */}
        <div className="w-64 border-r border-white/10 overflow-y-auto shrink-0 bg-black/10">
          {panel === "explorer" && (
            <FileExplorer
              repoId={repoId}
              activePath={activePath}
              dirtyPaths={dirtyPaths}
              onOpen={openFile}
              onDeleted={onDeletedFromExplorer}
              refreshToken={refreshToken}
            />
          )}
          {panel === "search" && <SearchPanel repoId={repoId} onOpenResult={openAtLine} />}
          {panel === "git" && hasGit && (
            <GitPanel
              repoId={repoId}
              saveMode={saveMode}
              onSaveModeChange={handleSaveModeChange}
              autoPush={autoPush}
              onAutoPushChange={setAutoPush}
              commitTemplate={commitTemplate}
              onCommitTemplateChange={setCommitTemplate}
              refreshToken={refreshToken}
              onMutated={() => setRefreshToken((n) => n + 1)}
              onOpenDiff={(path, diff) => setDiffModal({ path, diff })}
            />
          )}
        </div>

        {/* Main editing area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar */}
          <div className="flex items-center border-b border-white/10 bg-black/20 overflow-x-auto shrink-0">
            {tabs.map((t) => (
              <div
                key={t.path}
                onClick={() => setActivePath(t.path)}
                className={`group flex items-center gap-1.5 px-3 py-2 text-xs border-r border-white/5 cursor-pointer whitespace-nowrap ${
                  activePath === t.path ? "bg-[#0a0a0b] text-white" : "text-gray-400 hover:bg-white/[0.03]"
                }`}
              >
                <span>{t.path.split("/").pop()}</span>
                {t.dirty ? (
                  <Circle className="w-2 h-2 fill-amber-400 text-amber-400" />
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} className="opacity-0 group-hover:opacity-100 hover:text-white">
                    <X className="w-3 h-3" />
                  </button>
                )}
                {t.dirty && (
                  <button onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} className="hover:text-white">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-2 px-3 shrink-0">
              <label className="flex items-center gap-1 text-[11px] text-gray-500">
                <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} /> Auto-save
              </label>
              <button
                onClick={() => activePath && saveTab(activePath)}
                disabled={!activeTab?.dirty}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-white/10 text-gray-300 hover:bg-white/5 disabled:opacity-30"
              >
                <Save className="w-3 h-3" /> Save
              </button>
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 min-h-0 relative">
            {!activeTab && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
                {loadingPath ? "Opening…" : "Select a file to start editing"}
              </div>
            )}
            {activeTab && (
              <MonacoEditor
                key={activeTab.path}
                path={activeTab.path}
                defaultLanguage={lang.id}
                language={lang.id}
                value={activeTab.content}
                theme={theme}
                onChange={(v) => updateContent(activeTab.path, v ?? "")}
                onMount={handleEditorMount}
                options={{
                  minimap: { enabled: true },
                  fontSize: 13,
                  lineNumbers: "on",
                  folding: true,
                  matchBrackets: "always",
                  automaticLayout: true,
                  smoothScrolling: true,
                  cursorSmoothCaretAnimation: "on",
                  wordWrap: "off",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
          </div>
        </div>
      </div>

      <StatusBar
        gitStatus={gitStat}
        saveMode={saveMode}
        saveState={saveState}
        language={lang.label}
        cursor={activeTab ? cursor : null}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "vs-dark" ? "light" : "vs-dark"))}
        hasGit={hasGit}
      />

      {diffModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8" onClick={() => setDiffModal(null)}>
          <div className="bg-[#111113] border border-white/10 rounded-xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <span className="text-sm text-white font-mono">{diffModal.path}</span>
              <button onClick={() => setDiffModal(null)} className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <pre className="text-[11px] leading-relaxed p-4 overflow-auto font-mono flex-1">{colorizeDiff(diffModal.diff)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityBtn({ active, onClick, icon, title, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; badge?: number }) {
  return (
    <button onClick={onClick} title={title} className={`relative p-2.5 rounded-lg ${active ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300"}`}>
      {icon}
      {!!badge && <span className="absolute -top-0.5 -right-0.5 bg-purple-500 text-white text-[9px] rounded-full w-3.5 h-3.5 flex items-center justify-center">{badge > 9 ? "9+" : badge}</span>}
    </button>
  );
}

function colorizeDiff(diff: string): React.ReactNode {
  return diff.split("\n").map((line, i) => {
    let cls = "text-gray-400";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-emerald-400";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-rose-400";
    else if (line.startsWith("@@")) cls = "text-cyan-400";
    else if (line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---")) cls = "text-gray-500";
    return <div key={i} className={cls}>{line || " "}</div>;
  });
}
