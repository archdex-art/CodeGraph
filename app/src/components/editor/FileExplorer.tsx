"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen,
  Plus, FolderPlus, Trash2, Pencil, Copy, Download, Upload, Loader2,
} from "lucide-react";
import { fsList, fsCreate, fsDelete, fsRename, fsDuplicate, fsUpload, fsDownloadUrl } from "@/lib/api";
import type { FsEntry } from "@/lib/types";

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

interface DraftState {
  parent: string; // dir the draft lives in
  type: "file" | "dir";
}

interface RenameState {
  path: string;
  value: string;
}

export function FileExplorer({
  repoId,
  activePath,
  dirtyPaths,
  onOpen,
  onDeleted,
  refreshToken,
}: {
  repoId: string;
  activePath: string | null;
  dirtyPaths: Set<string>;
  onOpen: (path: string) => void;
  onDeleted: (path: string) => void;
  refreshToken: number;
}) {
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null);
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const uploadTargetRef = useRef<string>(".");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadDir(dir: string) {
    const entries = await fsList(repoId, dir);
    if (dir === ".") setRootEntries(entries);
    else setChildren((m) => new Map(m).set(dir, entries));
  }

  useEffect(() => {
    loadDir(".");
    setChildren(new Map());
    setExpanded(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, refreshToken]);

  useEffect(() => {
    function close() { setMenu(null); }
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  async function toggleDir(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!children.has(path)) await loadDir(path);
    }
    setExpanded(next);
  }

  async function refreshParentOf(path: string) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    await loadDir(parent);
  }

  function openMenu(e: React.MouseEvent, entry: FsEntry) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }

  async function handleCreate(parent: string, type: "file" | "dir", name: string) {
    if (!name.trim()) { setDraft(null); return; }
    const path = parent === "." ? name.trim() : `${parent}/${name.trim()}`;
    try {
      await fsCreate(repoId, path, type);
      await loadDir(parent);
      if (type === "file") onOpen(path);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setDraft(null);
    }
  }

  async function handleRename(entry: FsEntry, newName: string) {
    setRename(null);
    if (!newName.trim() || newName === entry.name) return;
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ".";
    const to = parent === "." ? newName.trim() : `${parent}/${newName.trim()}`;
    try {
      await fsRename(repoId, entry.path, to);
      await loadDir(parent);
      if (activePath === entry.path) onOpen(to);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rename failed");
    }
  }

  async function handleDelete(entry: FsEntry) {
    if (!confirm(`Delete ${entry.path}? This cannot be undone.`)) return;
    try {
      await fsDelete(repoId, entry.path);
      await refreshParentOf(entry.path);
      onDeleted(entry.path);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function handleDuplicate(entry: FsEntry) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ".";
    const dot = entry.name.lastIndexOf(".");
    const base = entry.type === "file" && dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const ext = entry.type === "file" && dot > 0 ? entry.name.slice(dot) : "";
    const to = parent === "." ? `${base} copy${ext}` : `${parent}/${base} copy${ext}`;
    try {
      await fsDuplicate(repoId, entry.path, to);
      await loadDir(parent);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Duplicate failed");
    }
  }

  async function handleMove(sourcePath: string, targetDir: string) {
    if (sourcePath === targetDir) return;
    const name = sourcePath.split("/").pop()!;
    const to = targetDir === "." ? name : `${targetDir}/${name}`;
    if (to === sourcePath) return;
    try {
      await fsRename(repoId, sourcePath, to);
      await refreshParentOf(sourcePath);
      await loadDir(targetDir);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Move failed");
    }
  }

  function triggerUpload(dir: string) {
    uploadTargetRef.current = dir;
    fileInputRef.current?.click();
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const dir = uploadTargetRef.current;
    for (const f of Array.from(files)) {
      const path = dir === "." ? f.name : `${dir}/${f.name}`;
      try {
        await fsUpload(repoId, path, f);
      } catch (e) {
        alert(`Upload failed for ${f.name}: ${e instanceof Error ? e.message : "error"}`);
      }
    }
    await loadDir(dir);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (rootEntries === null) {
    return <div className="flex items-center gap-2 text-xs text-gray-500 p-3"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading files…</div>;
  }

  return (
    <div
      className="text-sm select-none"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const src = e.dataTransfer.getData("text/cg-path");
        if (src) handleMove(src, ".");
      }}
    >
      <div className="flex items-center justify-between px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
        <span>Explorer</span>
        <div className="flex items-center gap-1">
          <button title="New file" onClick={() => setDraft({ parent: ".", type: "file" })} className="p-1 rounded hover:bg-white/10 hover:text-white">
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button title="New folder" onClick={() => setDraft({ parent: ".", type: "dir" })} className="p-1 rounded hover:bg-white/10 hover:text-white">
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button title="Upload file" onClick={() => triggerUpload(".")} className="p-1 rounded hover:bg-white/10 hover:text-white">
            <Upload className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => handleFilesSelected(e.target.files)} />

      {draft && draft.parent === "." && (
        <DraftRow depth={0} type={draft.type} onSubmit={(name) => handleCreate(".", draft.type, name)} onCancel={() => setDraft(null)} />
      )}

      {rootEntries.map((entry) => (
        <Node
          key={entry.path}
          entry={entry}
          depth={0}
          expanded={expanded}
          children_={children}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          onToggleDir={toggleDir}
          onOpen={onOpen}
          onMenu={openMenu}
          onMove={handleMove}
          draft={draft}
          onDraftSubmit={handleCreate}
          onDraftCancel={() => setDraft(null)}
          rename={rename}
          onRenameSubmit={handleRename}
          onRenameCancel={() => setRename(null)}
        />
      ))}

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onNewFile={() => setDraft({ parent: menu.entry.type === "dir" ? menu.entry.path : ".", type: "file" })}
          onNewFolder={() => setDraft({ parent: menu.entry.type === "dir" ? menu.entry.path : ".", type: "dir" })}
          onRename={() => setRename({ path: menu.entry.path, value: menu.entry.name })}
          onDuplicate={() => handleDuplicate(menu.entry)}
          onDelete={() => handleDelete(menu.entry)}
          onUpload={menu.entry.type === "dir" ? () => triggerUpload(menu.entry.path) : undefined}
          onDownload={menu.entry.type === "file" ? () => window.open(fsDownloadUrl(repoId, menu.entry.path), "_blank") : undefined}
        />
      )}
    </div>
  );
}

function Node({
  entry, depth, expanded, children_, activePath, dirtyPaths, onToggleDir, onOpen, onMenu, onMove,
  draft, onDraftSubmit, onDraftCancel, rename, onRenameSubmit, onRenameCancel,
}: {
  entry: FsEntry;
  depth: number;
  expanded: Set<string>;
  children_: Map<string, FsEntry[]>;
  activePath: string | null;
  dirtyPaths: Set<string>;
  onToggleDir: (path: string) => void;
  onOpen: (path: string) => void;
  onMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  onMove: (source: string, targetDir: string) => void;
  draft: DraftState | null;
  onDraftSubmit: (parent: string, type: "file" | "dir", name: string) => void;
  onDraftCancel: () => void;
  rename: RenameState | null;
  onRenameSubmit: (entry: FsEntry, newName: string) => void;
  onRenameCancel: () => void;
}) {
  const isDir = entry.type === "dir";
  const isOpen = expanded.has(entry.path);
  const isRenaming = rename?.path === entry.path;
  const kids = children_.get(entry.path);

  return (
    <div>
      {isRenaming ? (
        <RenameRow depth={depth} initial={entry.name} onSubmit={(v) => onRenameSubmit(entry, v)} onCancel={onRenameCancel} />
      ) : (
        <div
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/cg-path", entry.path)}
          onDragOver={(e) => { if (isDir) e.preventDefault(); }}
          onDrop={(e) => {
            if (!isDir) return;
            e.preventDefault();
            e.stopPropagation();
            const src = e.dataTransfer.getData("text/cg-path");
            if (src) onMove(src, entry.path);
          }}
          onClick={() => (isDir ? onToggleDir(entry.path) : onOpen(entry.path))}
          onContextMenu={(e) => onMenu(e, entry)}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={`flex items-center gap-1 py-1 pr-2 cursor-pointer rounded-sm hover:bg-white/[0.06] ${
            activePath === entry.path ? "bg-white/[0.09] text-white" : "text-gray-300"
          }`}
        >
          {isDir ? (
            <>
              {isOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-500" />}
              {isOpen ? <FolderOpen className="w-3.5 h-3.5 shrink-0 text-sky-400" /> : <Folder className="w-3.5 h-3.5 shrink-0 text-sky-400" />}
            </>
          ) : (
            <>
              <span className="w-3.5 shrink-0" />
              <FileIcon className="w-3.5 h-3.5 shrink-0 text-gray-500" />
            </>
          )}
          <span className="truncate text-[13px]">{entry.name}</span>
          {dirtyPaths.has(entry.path) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 ml-auto shrink-0" />}
        </div>
      )}

      {isDir && isOpen && draft && draft.parent === entry.path && (
        <DraftRow depth={depth + 1} type={draft.type} onSubmit={(name) => onDraftSubmit(entry.path, draft.type, name)} onCancel={onDraftCancel} />
      )}

      {isDir && isOpen && kids?.map((child) => (
        <Node
          key={child.path}
          entry={child}
          depth={depth + 1}
          expanded={expanded}
          children_={children_}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          onToggleDir={onToggleDir}
          onOpen={onOpen}
          onMenu={onMenu}
          onMove={onMove}
          draft={draft}
          onDraftSubmit={onDraftSubmit}
          onDraftCancel={onDraftCancel}
          rename={rename}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        />
      ))}
    </div>
  );
}

function DraftRow({ depth, type, onSubmit, onCancel }: { depth: number; type: "file" | "dir"; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div style={{ paddingLeft: 8 + depth * 14 }} className="flex items-center gap-1 py-1 pr-2">
      {type === "dir" ? <Folder className="w-3.5 h-3.5 shrink-0 text-sky-400" /> : <FileIcon className="w-3.5 h-3.5 shrink-0 text-gray-500" />}
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => (value.trim() ? onSubmit(value) : onCancel())}
        placeholder={type === "dir" ? "folder name" : "file name"}
        className="bg-[#0a0a0a] border border-purple-500/40 rounded px-1.5 py-0.5 text-[13px] text-white outline-none w-full"
      />
    </div>
  );
}

function RenameRow({ depth, initial, onSubmit, onCancel }: { depth: number; initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div style={{ paddingLeft: 8 + depth * 14 }} className="flex items-center gap-1 py-1 pr-2">
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onSubmit(value)}
        className="bg-[#0a0a0a] border border-purple-500/40 rounded px-1.5 py-0.5 text-[13px] text-white outline-none w-full"
      />
    </div>
  );
}

function ContextMenu({
  menu, onClose, onNewFile, onNewFolder, onRename, onDuplicate, onDelete, onUpload, onDownload,
}: {
  menu: MenuState;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onUpload?: () => void;
  onDownload?: () => void;
}) {
  const item = (label: string, icon: React.ReactNode, fn: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); fn(); onClose(); }}
      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white text-left"
    >
      {icon}{label}
    </button>
  );
  return (
    <div
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-50 bg-[#111113] border border-white/10 rounded-lg shadow-2xl py-1 w-44"
      onClick={(e) => e.stopPropagation()}
    >
      {menu.entry.type === "dir" && item("New File", <Plus className="w-3.5 h-3.5" />, onNewFile)}
      {menu.entry.type === "dir" && item("New Folder", <FolderPlus className="w-3.5 h-3.5" />, onNewFolder)}
      {onUpload && item("Upload Here", <Upload className="w-3.5 h-3.5" />, onUpload)}
      {onDownload && item("Download", <Download className="w-3.5 h-3.5" />, onDownload)}
      {item("Rename", <Pencil className="w-3.5 h-3.5" />, onRename)}
      {item("Duplicate", <Copy className="w-3.5 h-3.5" />, onDuplicate)}
      <div className="border-t border-white/10 my-1" />
      {item("Delete", <Trash2 className="w-3.5 h-3.5 text-rose-400" />, onDelete)}
    </div>
  );
}
