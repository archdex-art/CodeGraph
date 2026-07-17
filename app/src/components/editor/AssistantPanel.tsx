"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, Loader2, RotateCcw, Send, XCircle, Square, PanelRightClose, Settings } from "lucide-react";
import { resetAssistant, streamAssistantChat, updateAssistantSettings } from "@/lib/api";
import type { AssistantEvent, AssistantProvider, AssistantProviders } from "@/lib/types";

type ToolStatus = "running" | "ok" | "error";

type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: Record<string, unknown>; status: ToolStatus; summary?: string };

type Turn = { role: "user"; text: string } | { role: "assistant"; blocks: AssistantBlock[]; error?: string };

// Tools whose successful result means a file on disk changed under the
// user's feet — used to refresh any open tab for that path.
const WRITE_TOOLS: Record<string, "path" | "from-to"> = {
  write_file: "path",
  create_entry: "path",
  rename_entry: "from-to",
  delete_entry: "path",
};

// Stable Claude model aliases the Claude Agent SDK resolves to the latest
// snapshot of each tier (see Options.model in @anthropic-ai/claude-agent-sdk).
const CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: "opus", label: "Claude Opus (most capable)" },
  { value: "sonnet", label: "Claude Sonnet (balanced)" },
  { value: "haiku", label: "Claude Haiku (fastest)" },
];

function pathsTouchedBy(tool: string, input: Record<string, unknown>): string[] {
  const kind = WRITE_TOOLS[tool];
  if (!kind) return [];
  if (kind === "path") return typeof input.path === "string" ? [input.path] : [];
  const from = typeof input.from === "string" ? input.from : null;
  const to = typeof input.to === "string" ? input.to : null;
  return [from, to].filter((p): p is string => p !== null);
}

export function AssistantPanel({
  repoId,
  providers,
  onOpenFile,
  onFileTouched,
  onMutated,
  onClose,
}: {
  repoId: string;
  providers: AssistantProviders;
  onOpenFile: (path: string) => void;
  onFileTouched: (path: string) => void;
  onMutated: () => void;
  onClose?: () => void;
}) {
  const [providerOverride, setProviderOverride] = useState<AssistantProvider | null>(null);
  const provider: AssistantProvider = providerOverride ?? (providers.claude ? "claude" : "local");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [draft, setDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [localModels, setLocalModels] = useState<string[]>([]);
  // Model selection follows whatever the server currently reports until the
  // user explicitly picks one in this session -- avoids ever needing to
  // "correct" stale local state once `providers` (fetched asynchronously by
  // the parent, after this panel's own first render) resolves.
  const [localModelOverride, setLocalModelOverride] = useState<string | null>(null);
  const currentLocalModel = localModelOverride ?? providers.localModel ?? null;
  const [claudeModelOverride, setClaudeModelOverride] = useState<string | null>(null);
  const currentClaudeModel = claudeModelOverride ?? providers.claudeModel ?? "sonnet";

  useEffect(() => {
    if (providers.local) {
      fetch('/api/settings/models').then(r => r.json()).then(d => {
        if (d.models && Array.isArray(d.models)) {
          setLocalModels(d.models);
        }
      }).catch(() => {});
    }
  }, [providers.local]);

  async function handleModelChange(m: string) {
    if (provider === "local") {
      setLocalModelOverride(m);
      await updateAssistantSettings({ localModel: m });
      newChat();
    } else {
      setClaudeModelOverride(m);
      await updateAssistantSettings({ claudeModel: m });
      newChat();
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const applyEvent = useCallback(
    (event: AssistantEvent) => {
      let pathsToTouch: string[] = [];
      let shouldMutate = false;

      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") return prev; // shouldn't happen — placeholder always pushed first

        if (event.kind === "text") {
          const blocks = [...last.blocks];
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock?.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: lastBlock.text + event.text };
          else blocks.push({ kind: "text", text: event.text });
          next[next.length - 1] = { ...last, blocks };
        } else if (event.kind === "tool_call") {
          next[next.length - 1] = {
            ...last,
            blocks: [...last.blocks, { kind: "tool", tool: event.tool, input: event.input, status: "running" }],
          };
        } else if (event.kind === "tool_result") {
          const blocks = [...last.blocks];
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.kind === "tool" && b.tool === event.tool && b.status === "running") {
              blocks[i] = { ...b, status: event.ok ? "ok" : "error", summary: event.summary };
              if (event.ok) {
                pathsToTouch = pathsTouchedBy(b.tool, b.input);
                shouldMutate = true;
              }
              break;
            }
          }
          next[next.length - 1] = { ...last, blocks };
        } else if (event.kind === "error") {
          next[next.length - 1] = { ...last, error: event.message };
        }
        // "done" carries only cost/turn telemetry — nothing to render.
        return next;
      });

      for (const p of pathsToTouch) onFileTouched(p);
      if (shouldMutate) onMutated();
    },
    [onFileTouched, onMutated],
  );

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setHistory((prev) => [...prev, text]);
    setHistoryIdx(-1);
    setDraft("");
    setTurns((prev) => [...prev, { role: "user", text }, { role: "assistant", blocks: [] }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAssistantChat(repoId, text, provider, applyEvent, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        const message = e instanceof Error ? e.message : "Assistant request failed";
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, error: message };
          return next;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function newChat() {
    abortRef.current?.abort();
    setBusy(false);
    setTurns([]);
    try {
      await resetAssistant(repoId);
    } catch {
      /* best-effort — a stale server session self-heals on next message */
    }
  }

  function switchProvider(next: AssistantProvider) {
    if (next === provider) return;
    setProviderOverride(next);
    newChat(); // a Claude and a local-model conversation are unrelated histories
  }

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
        <div className="text-[11px] uppercase tracking-wide text-gray-500">AI Assistant</div>
        <div className="flex items-center gap-2">
          <button onClick={newChat} title="New chat" className="text-gray-500 hover:text-white">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          {onClose && (
            <button onClick={onClose} title="Collapse panel" className="text-gray-500 hover:text-white">
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {!providers.claude && !providers.local && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <Bot className="w-8 h-8 text-gray-700" />
          <p className="text-gray-500 leading-relaxed">
            No AI provider is configured yet. Add a Claude API key or point at your own local model to start chatting.
          </p>
          <a
            href="/settings"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20"
          >
            <Settings className="w-3.5 h-3.5" /> Open Settings
          </a>
        </div>
      )}

      {(providers.claude || providers.local) && (
        <>

      {providers.claude && providers.local && (
        <div className="flex items-center gap-1 px-3 pb-2 shrink-0">
          {(["claude", "local"] as const).map((p) => (
            <button
              key={p}
              onClick={() => switchProvider(p)}
              className={`px-2 py-0.5 rounded text-[11px] border ${
                provider === p ? "border-purple-500/50 text-white bg-white/5" : "border-white/10 text-gray-500 hover:text-gray-300"
              }`}
            >
              {p === "claude" ? "Claude" : "Local model"}
            </button>
          ))}
        </div>
      )}
      
      <div className="px-3 pb-2 shrink-0">
        {provider === "local" ? (
          localModels.length > 0 ? (
            <select 
              value={currentLocalModel || ""} 
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-purple-500/50"
            >
              {localModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <div className="w-full bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-[11px] text-gray-500 truncate" title={currentLocalModel || "No model configured"}>
              {currentLocalModel || "No model configured"}
            </div>
          )
        ) : (
          <select
            value={currentClaudeModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="w-full bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-purple-500/50"
          >
            {CLAUDE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 space-y-3">
        {turns.length === 0 && (
          <p className="text-gray-600 leading-relaxed">
            Ask it to explain, refactor, or edit files in this repository. It can read, write, search, and (if this
            is a git workspace) check status/diff/commit — nothing else.
          </p>
        )}
        {turns.map((turn, i) => (
          <div key={i}>
            {turn.role === "user" ? (
              <div className="rounded bg-white/5 px-2 py-1.5 text-gray-200 whitespace-pre-wrap break-words">{turn.text}</div>
            ) : (
              <div className="space-y-1.5">
                {turn.blocks.map((block, j) =>
                  block.kind === "text" ? (
                    <p key={j} className="text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
                      {block.text}
                    </p>
                  ) : (
                    <button
                      key={j}
                      onClick={() => {
                        const [p] = pathsTouchedBy(block.tool, block.input).slice(-1);
                        onOpenFile(p ?? String(block.input.path ?? ""));
                      }}
                      title={block.summary}
                      className="w-full text-left flex items-center gap-1.5 rounded border border-white/10 bg-black/20 px-2 py-1 text-gray-400 hover:border-white/20"
                    >
                      {block.status === "running" && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                      {block.status === "ok" && <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-400" />}
                      {block.status === "error" && <XCircle className="w-3 h-3 shrink-0 text-red-400" />}
                      <span className="font-mono truncate">{block.tool}</span>
                    </button>
                  ),
                )}
                {turn.error && <p className="text-red-400 leading-relaxed">⚠ {turn.error}</p>}
              </div>
            )}
          </div>
        ))}
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
      </div>

      <div className="p-3 shrink-0 border-t border-white/10 mt-2">
        <div className="flex items-end gap-1.5 bg-[#0a0a0a] border border-white/10 rounded px-2 py-1.5 focus-within:border-purple-500/50">
          <Bot className="w-3.5 h-3.5 text-gray-600 mb-1 shrink-0" />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === "ArrowUp") {
                if (historyIdx < history.length - 1) {
                  if (historyIdx !== -1 || e.currentTarget.selectionStart === 0) {
                    e.preventDefault();
                    if (historyIdx === -1) setDraft(input);
                    const nextIdx = historyIdx + 1;
                    setHistoryIdx(nextIdx);
                    setInput(history[history.length - 1 - nextIdx]);
                  }
                }
              } else if (e.key === "ArrowDown") {
                if (historyIdx !== -1) {
                  e.preventDefault();
                  const nextIdx = historyIdx - 1;
                  setHistoryIdx(nextIdx);
                  if (nextIdx === -1) setInput(draft);
                  else setInput(history[history.length - 1 - nextIdx]);
                }
              }
            }}
            placeholder="Ask the AI Assistant…"
            rows={2}
            disabled={busy}
            className="flex-1 bg-transparent outline-none text-gray-200 placeholder:text-gray-600 resize-none disabled:opacity-50"
          />
          {busy ? (
            <button onClick={() => abortRef.current?.abort()} className="text-red-400 hover:text-red-300 mb-1 shrink-0 p-0.5 rounded hover:bg-white/5" title="Stop">
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim()} className="text-gray-500 hover:text-white disabled:opacity-30 mb-1 shrink-0 p-0.5" title="Send">
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  );
}
