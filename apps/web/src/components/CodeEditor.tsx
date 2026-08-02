"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { OnMount } from "@monaco-editor/react";
import {
  FolderTree, Search as SearchIcon, GitBranch as GitBranchIcon, Trash2, X, Save, Circle, GitCompare, TriangleAlert,
} from "lucide-react";
import { FileExplorer } from "./editor/FileExplorer";
import { GitPanel } from "./editor/GitPanel";
import { SearchPanel } from "./editor/SearchPanel";
import { AssistantPanel } from "./editor/AssistantPanel";
import { fetchAssistantProviders } from "@/lib/api";
import type { AssistantProviders } from "@/lib/types";
import { Bot } from "lucide-react";
import { logger } from "@codegraph/observability";
import { TrashPanel } from "./editor/TrashPanel";
import { IssuesPanel } from "./editor/IssuesPanel";
import { StatusBar, type SaveState } from "./editor/StatusBar";
import { fsRead, fsWrite, gitStatus as fetchGitStatus, gitCommit, gitPush, getSaveMode, setSaveMode as persistSaveMode, trashList } from "@/lib/api";
import { languageForPath } from "@/lib/editorLang";
import type { GitStatus, RepoDetail, SaveMode } from "@/lib/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), { ssr: false });
const MonacoDiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), { ssr: false });

type Panel = "explorer" | "search" | "git" | "trash" | "issues";

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

export function CodeEditor({
  repo,
  visible = true,
  openTarget = null,
}: {
  repo: RepoDetail;
  visible?: boolean;
  /**
   * A file (and optionally a line) to open on arrival — how the report's findings
   * link into the editor. Identified by `key` rather than by value so that clicking
   * the SAME finding twice still re-reveals it: the second navigation carries an
   * identical file and line, and comparing those alone makes it a no-op.
   */
  openTarget?: { key: string; file: string; line: number } | null;
}) {
  const repoId = repo.id;
  const persisted = useMemo(() => loadPersisted(repoId), [repoId]);

  /**
   * Arriving on a finding selects the Issues panel — adjusted DURING RENDER against the
   * previous target key, not synced in an effect. React documents this as the way to
   * reset state when a prop changes; doing it in an effect renders the wrong panel for
   * one frame first and is a cascading render besides. The panel stays user-controlled
   * afterwards: only a NEW target moves it again.
   */
  const openTargetKey = openTarget?.key ?? null;
  const [panel, setPanel] = useState<Panel>(openTarget ? "issues" : "explorer");
  const [seenTargetKey, setSeenTargetKey] = useState(openTargetKey);
  if (openTargetKey !== seenTargetKey) {
    setSeenTargetKey(openTargetKey);
    if (openTargetKey) setPanel("issues");
  }
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
  const [diffView, setDiffView] = useState(false);
  const [gitStat, setGitStat] = useState<GitStatus | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [diffModal, setDiffModal] = useState<{ path: string; diff: string } | null>(null);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantProviders, setAssistantProviders] = useState<AssistantProviders>({ claude: false, local: false });
  
  useEffect(() => {
    fetchAssistantProviders(repoId).then(setAssistantProviders).catch(() => setAssistantProviders({ claude: false, local: false }));
  }, [repoId]);

  const refreshFileFromDisk = useCallback(async (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.dirty) return;
    try {
      const { content, binary } = await fsRead(repoId, path);
      if (binary) return;
      setTabs((prev) => prev.map((t) => (t.path === path && !t.dirty ? { ...t, content, dirty: t.original !== content } : t)));
    } catch {
      // Renamed/deleted by the assistant
    }
  }, [repoId]);
  const [trashCount, setTrashCount] = useState(0);
  const [pendingReveal, setPendingReveal] = useState<{ path: string; line: number } | null>(null);
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
      // Deduped: a stored list is replayed verbatim on every load, so one duplicate
      // written by any bug — or by two windows persisting over each other — reopens
      // the same file in two tabs forever. Found exactly that way.
      for (const p of [...new Set(st.openTabs)]) {
        try {
          const { content, binary } = await fsRead(repoId, p);
          if (!binary) restoredTabs.push({ path: p, content, original: content, dirty: false });
        } catch { /* file gone, skip */ }
      }
      // Merged, not assigned. A deep link (`?file=…`) opens its file immediately, while
      // this restore is still awaiting one `fsRead` per stored tab — and a bare
      // `setTabs(restoredTabs)` would throw that arrival away, leaving the URL's file
      // revealed in an editor whose tab no longer exists.
      setTabs((arrived) => [
        ...restoredTabs,
        ...arrived.filter((t) => !restoredTabs.some((r) => r.path === t.path)),
      ]);
      setActivePath((current) =>
        current ?? (st.activeTab && restoredTabs.some((t) => t.path === st.activeTab)
          ? st.activeTab
          : restoredTabs[0]?.path ?? null)
      );
      restoredRef.current = true;
    })();
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

  const refreshTrash = useCallback(() => {
    trashList(repoId).then((entries) => setTrashCount(entries.length)).catch(() => setTrashCount(0));
  }, [repoId]);

  useEffect(() => { refreshTrash(); }, [refreshTrash, refreshToken]);

  // Warn on tab close / navigation with unsaved work.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (tabs.some((t) => t.dirty)) { e.preventDefault(); }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tabs]);

  const activeTab = tabs.find((t) => t.path === activePath) || null;

  /**
   * Open a file, at most once.
   *
   * The "already open?" test reads `tabsRef`, not the `tabs` closure, and the append
   * dedupes inside the updater — because the read and the append are separated by an
   * await, so two calls for the same path can both pass the guard before either lands.
   * That is not hypothetical: arriving on a finding fires the open once, React's
   * StrictMode double-invokes the effect in development, and the editor came up with
   * the same file in two tabs. `inFlight` closes the window; the updater's `some`
   * check is the backstop that does not depend on it.
   *
   * Reading through the ref also keeps this callback stable across tab changes, which
   * is what lets the arrival effect depend on the target key alone.
   */
  const inFlightOpens = useRef<Set<string>>(new Set());

  const openFile = useCallback(async (path: string) => {
    if (tabsRef.current.some((t) => t.path === path)) { setActivePath(path); return; }
    if (inFlightOpens.current.has(path)) return;
    inFlightOpens.current.add(path);
    setLoadingPath(path);
    try {
      const { content, binary, truncated } = await fsRead(repoId, path);
      if (binary) {
        alert("This file appears to be binary and cannot be edited here. Use Download instead.");
        return;
      }
      if (truncated) {
        // still open — best effort — flag to user
        logger.warn("File truncated for editing (exceeds size cap)", { path });
      }
      setTabs((prev) =>
        prev.some((t) => t.path === path) ? prev : [...prev, { path, content, original: content, dirty: false }]
      );
      setActivePath(path);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to open file");
    } finally {
      inFlightOpens.current.delete(path);
      setLoadingPath(null);
    }
  }, [repoId]);

  const openAtLine = useCallback(async (path: string, line: number) => {
    await openFile(path);
    setActivePath(path);
    // The reveal carries its PATH, not just a line number: switching tabs remounts
    // Monaco (`key={activeTab.path}`), so a bare line would be applied to whichever
    // instance happens to be alive — which is the outgoing one.
    setPendingReveal({ path, line });
  }, [openFile]);

  /**
   * Arrive on a finding: open its file and reveal its line.
   *
   * Keyed on `openTarget.key` ALONE. Depending on `openAtLine` would re-run this on
   * every tab change — `openFile` closes over `tabs` — and yank the cursor back to the
   * finding while you were reading somewhere else, so the callback is reached through
   * a ref. Which panel is showing is decided during render, above; this effect only
   * does the part that is genuinely a side effect: fetching the file.
   */
  const openAtLineRef = useRef(openAtLine);
  useEffect(() => {
    openAtLineRef.current = openAtLine;
  }, [openAtLine]);

  useEffect(() => {
    if (!openTarget) return;
    void openAtLineRef.current(openTarget.file, openTarget.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTargetKey]);

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
          logger.warn("Auto-commit/push failed", { err: e, repoId, path });
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

  /**
   * Revealing a line is harder than it looks here, for two reasons that both bite:
   *
   * 1. The editor is a dynamic import, so a reveal requested on arrival (`?file=…&line=…`)
   *    happens BEFORE Monaco exists. An effect cannot catch that moment, because
   *    mounting the editor writes a ref, which schedules no render — the deep link
   *    opened the right file at line 1.
   * 2. `key={activeTab.path}` means switching tabs UNMOUNTS and remounts Monaco. A
   *    reveal fired while the outgoing instance is still in `editorRef` lands on a dying
   *    editor and is lost — clicking an issue in another file switched tab and stayed at
   *    line 1.
   *
   * So the reveal is applied by whichever instance actually owns the requested path:
   * the mount handler when the editor arrives after the request, the effect when the
   * request arrives after the editor. `mountedPathRef` is what distinguishes them.
   */
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);
  useEffect(() => {
    pendingRevealRef.current = pendingReveal;
  }, [pendingReveal]);

  const mountedPathRef = useRef<string | null>(null);

  const applyReveal = (editor: Parameters<OnMount>[0], line: number) => {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  };

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    mountedPathRef.current = activePath;
    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }));
    const target = pendingRevealRef.current;
    if (target && target.path === activePath) {
      applyReveal(editor, target.line);
      setPendingReveal(null);
    }
  };

  useEffect(() => {
    if (!pendingReveal || !editorRef.current) return;
    // Not this file's editor yet — the remount will pick the request up on mount.
    if (pendingReveal.path !== activePath || mountedPathRef.current !== activePath) return;
    applyReveal(editorRef.current, pendingReveal.line);
    setPendingReveal(null);
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
    <div className="rounded-xl border border-white/10 bg-[#0a0a0b] overflow-hidden flex flex-col" style={{ height: "78vh" }}>
      <div className="flex flex-1 min-h-0">
        {/* Activity bar */}
        <div className="w-12 border-r border-white/10 flex flex-col items-center py-sm gap-2xs bg-black/20 shrink-0">
          <ActivityBtn active={panel === "explorer"} onClick={() => setPanel("explorer")} icon={<FolderTree className="w-4.5 h-4.5" />} title="Explorer" />
          <ActivityBtn active={panel === "search"} onClick={() => setPanel("search")} icon={<SearchIcon className="w-4.5 h-4.5" />} title="Search" />
          <ActivityBtn
            active={panel === "issues"}
            onClick={() => setPanel("issues")}
            icon={<TriangleAlert className="w-4.5 h-4.5" />}
            title="Issues"
            badge={repo.issues.length > 0 ? repo.issues.length : undefined}
          />
          {hasGit && (
            <ActivityBtn active={panel === "git"} onClick={() => setPanel("git")} icon={<GitBranchIcon className="w-4.5 h-4.5" />} title="Source Control" badge={gitStat && gitStat.entries.length > 0 ? gitStat.entries.length : undefined} />
          )}
          <ActivityBtn active={panel === "trash"} onClick={() => setPanel("trash")} icon={<Trash2 className="w-4.5 h-4.5" />} title="Trash" badge={trashCount > 0 ? trashCount : undefined} />
        </div>

        {/* Side panel */}
        <div className="w-64 border-r border-white/10 overflow-y-auto shrink-0 bg-black/10">
          <div className={panel === "explorer" ? "block h-full" : "hidden"}>
            <FileExplorer
              repoId={repoId}
              activePath={activePath}
              dirtyPaths={dirtyPaths}
              onOpen={openFile}
              onDeleted={onDeletedFromExplorer}
              refreshToken={refreshToken}
            />
          </div>
          <div className={panel === "search" ? "block h-full" : "hidden"}>
            <SearchPanel repoId={repoId} onOpenResult={openAtLine} />
          </div>
          <div className={panel === "issues" ? "block h-full" : "hidden"}>
            <IssuesPanel issues={repo.issues} activePath={activePath} onOpenIssue={openAtLine} />
          </div>
          {hasGit && (
            <div className={panel === "git" ? "block h-full" : "hidden"}>
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
            </div>
          )}
          <div className={panel === "trash" ? "block h-full" : "hidden"}>
            <TrashPanel repoId={repoId} onMutated={() => setRefreshToken((n) => n + 1)} />
          </div>
        </div>

        {/* Main editing area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar */}
          <div className="flex items-center border-b border-white/10 bg-black/20 overflow-x-auto shrink-0">
            {tabs.map((t) => (
              <div
                key={t.path}
                onClick={() => setActivePath(t.path)}
                className={`group flex items-center gap-xs px-md py-sm text-meta border-r border-white/5 cursor-pointer whitespace-nowrap ${
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
            <div className="flex items-center gap-sm px-md shrink-0">
              <label className="flex items-center gap-2xs text-meta text-gray-500">
                <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} /> Auto-save
              </label>
              <button
                onClick={() => setDiffView(!diffView)}
                className={`flex items-center gap-2xs text-meta px-sm py-2xs rounded-xs border ${
                  diffView ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : "border-white/10 text-gray-400 hover:bg-white/5 hover:text-gray-300"
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" /> Diff
              </button>
              <button
                onClick={() => activePath && saveTab(activePath)}
                disabled={!activeTab?.dirty}
                className="flex items-center gap-2xs text-meta px-sm py-2xs rounded-xs border border-white/10 text-gray-300 hover:bg-white/5 disabled:opacity-30"
              >
                <Save className="w-3 h-3" /> Save
              </button>
            </div>
            <button
              onClick={() => setAssistantOpen(!assistantOpen)}
              className={`flex items-center gap-2xs text-meta px-sm py-2xs rounded-xs border ${
                assistantOpen ? "border-purple-500/50 bg-purple-500/10 text-white" : "border-white/10 text-gray-400 hover:bg-white/5 hover:text-gray-300"
              }`}
            >
              <Bot className="w-3.5 h-3.5" /> AI Assistant
            </button>
          </div>

          {/* Editor Area */}
          <div className="flex-1 min-h-0 relative flex">
            <div className="flex-1 min-w-0 relative">
              {!activeTab && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-meta">
                  {loadingPath ? "Opening…" : "Select a file to start editing"}
                </div>
              )}
              {activeTab && (
                diffView ? (
                  <MonacoDiffEditor
                    key={activeTab.path + "-diff"}
                    original={activeTab.original}
                    modified={activeTab.content}
                    language={lang.id}
                    theme={theme}
                    options={{
                      renderSideBySide: false,
                      minimap: { enabled: false },
                      readOnly: true,
                      fontSize: 13,
                      fontFamily: "var(--font-geist-mono), monospace",
                      scrollBeyondLastLine: false,
                    }}
                  />
                ) : (
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
                )
              )}
            </div>
            {/* Assistant Panel (Right) */}
            <div className={`w-80 border-l border-white/10 flex flex-col bg-[#050505] shrink-0 ${assistantOpen ? "block" : "hidden"}`}>
              <AssistantPanel
                repoId={repoId}
                providers={assistantProviders}
                onOpenFile={openFile}
                onFileTouched={refreshFileFromDisk}
                onMutated={() => setRefreshToken((n) => n + 1)}
                onClose={() => setAssistantOpen(false)}
              />
            </div>
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
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-xl" onClick={() => setDiffModal(null)}>
          <div className="bg-[#111113] border border-white/10 rounded-xl max-w-measure w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-md py-md border-b border-white/10">
              <span className="text-meta text-white font-mono">{diffModal.path}</span>
              <button onClick={() => setDiffModal(null)} className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <pre className="text-meta p-md overflow-auto font-mono flex-1">{colorizeDiff(diffModal.diff)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityBtn({ active, onClick, icon, title, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; badge?: number }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className={`relative p-sm rounded-lg ${active ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300"}`}>
      {icon}
      {!!badge && <span className="absolute -top-0.5 -right-0.5 bg-purple-500 text-white text-micro rounded-full w-3.5 h-3.5 flex items-center justify-center">{badge > 9 ? "9+" : badge}</span>}
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
