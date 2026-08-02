# CodeGraph — Autonomous Agent Swarm

The capstone layer: a swarm of specialized agents that reason over the knowledge graph, critique each other, and a judge emits a **ranked remediation plan**. Deterministic and grounded in the graph — **no external LLM API key required** to run.

## Model
```
runSwarm(repo)
  │
  ├─ 1. SPECIALISTS (parallel, shared graph memory)
  │     Security · Performance · Refactor · Dead code · Dependency · Architecture · Test
  │     each emits Finding[] { severity, confidence, blastRadius, suggestedFix, effort, … }
  │
  ├─ 2. CRITIC   dedupe by locus + cross-corroborate
  │     (multiple agents flagging the same spot ⇒ confidence boost)
  │
  ├─ 3. JUDGE    score = severity × log(blastRadius) × confidence × effortBonus
  │     → priority P0/P1/P2/P3 (security-critical auto-P0)
  │
  └─ 4. PLAN     ranked findings + buckets + projected Health Score after P0+P1
```

## Specialists (`src/lib/agents/specialists.ts`)
| Agent | Source signal | Emits |
|---|---|---|
| **Security** | security issues (eval, secrets, SQL concat, taint) | fix per vuln class |
| **Performance** | graph hubs (high fan-in = hot paths) | optimize-hot-path |
| **Refactor** | god-files / complexity | split-module |
| **Dead code** | symbols with 0 resolved callers | remove-after-verify |
| **Dependency** | manifest hygiene (unpinned, no lockfile) | pin/lock |
| **Architecture** | call-graph cycles (Tarjan SCC) | break-cycle |
| **Test** | coverage gaps | add-tests-by-fan-in |

Each specialist implements the `Specialist` interface → **add an agent without touching the orchestrator** (Open/Closed).

## Orchestrator (`src/lib/agents/orchestrator.ts`)
- **Critic** merges duplicate findings at the same `file:line`, unions corroborating agents, and raises confidence (+0.15 per corroborator).
- **Judge** ranks by `severity × log2(1+blastRadius) × confidence × effortBonus` (quick wins ranked up); security S≥4 forced to P0.
- **Projected score**: bounded estimate of Health-Score recovery if P0+P1 are addressed.

## API
`GET /api/repos/:id/agents` → `RemediationPlan { repoScore, projectedScore, buckets, topFindings, agents[], summary }`.

## UI
Repo report → **Agents** tab (`src/components/AgentSwarm.tsx`): run button → projected-score card, per-specialist report cards, priority filter, and expandable findings each with a concrete **suggested fix**, confidence, score, blast radius, effort, and corroboration.

## Verified (express, live)
- 69 findings across 6 active specialists; buckets P0:10 / P1:18 / P2:39 / P3:2.
- Projected Health Score **90 → 100** after P0+P1.
- Real findings: `Hot path: render (21 callers)`, hardcoded secrets in `examples/*`, `Use of eval()` in `test/res.redirect.js:115` → fix "Replace eval() with a safe parser or explicit dispatch table."

## M4 — Remediation Executor (BUILT)
The agent plan is the task backlog for the executor (`src/lib/agents/executor.ts`), which closes the loop:

```
POST /api/repos/:id/fix
  acquire  → clone/copy the source into a DISPOSABLE sandbox (original never touched)
  analyze  → index baseline (score + issue count)
  apply    → run safe deterministic Fixers (src/lib/agents/fixers.ts) as codemods
  verify   → RE-INDEX the patched tree; require score not-regressed & issues not-increased
  diff     → emit a valid unified git diff (deletion-aware)
  record   → assemble PRDraft (title/body/branch/diff) + replayable ExecutionStep[]
```

- **Safety bar:** a Fixer ships only if its change cannot alter production behavior in the common case AND removes an issue the scorer counts — so "verified" is honest. Current fixer: `remove-debug-output` (standalone `console.log`/`debug`/`info`, `debugger`, python `print()`), whole-line only (never splits an expression; verified by unit tests).
- **UI:** the Agents tab has a "Generate verified fix PR" button → execution-step timeline, verified verdict with score delta, PR draft (copy body/diff), and a colorized diff.

### Verified (express, live)
- 31 fixes across 27 files; **Health Score 90 → 93, issues 53 → 29**; all 6 steps green; valid git diff.
- The verdict is genuine: score/issue deltas come from a real re-index of the patched sandbox, not a claim.

## Next (M5)
Add more fixers behind the same safety bar (unpinned-dep pinning via lockfile, unused-import removal), and optional real PR creation via a GitHub token (push branch + open PR) — the diff + branch + body are already produced.

## M6 — Built-in Editor + Git Integration (BUILT)

A VS Code Web–style editor lives at the repo report's **Editor** tab (`src/components/CodeEditor.tsx`), backed by a **persistent on-disk workspace** per repo instead of the disposable clone used for indexing.

```
index a repo (git|local)
  → workspace_dir persisted on the `repos` row (git clones are no longer deleted after indexing)
  → RepoDetail.hasWorkspace signals the editor is available
  → all fs/git operations below run server-side, scoped to that one directory
```

### Filesystem (`src/lib/workspace.ts`, `/api/repos/:id/fs`)
Every path is resolved with `resolveSafe()` and rejected if it would escape the workspace root (`WorkspacePathError` → 400) — verified live against a `../../../etc/passwd` traversal attempt. Ops: `list` (lazy, one directory level), `read` (binary-sniffed, size-capped at 4MB), `write`, `create` (file/dir), `rename`/`move`, `duplicate`, `upload` (base64 → bytes), `download` (raw byte stream). `DELETE` refuses to remove the workspace root itself and is **restorable**: it moves the entry into the repo's trash (`src/lib/trash.ts`, `/api/repos/:id/trash`) instead of erasing it — this matters most for **local** source repos, where the workspace root is the user's real folder on disk.

### Git (`src/lib/gitops.ts`, `/api/repos/:id/git`)
Thin wrapper over `execFile("git", […])` — argv arrays only, never a shell string, so branch names/commit messages/paths can't inject commands. Ops: `status` (porcelain v2 → modified/added/deleted/untracked/renamed/conflicted), `branches` (local + remote, symbolic remote HEAD filtered out via `%(symref:short)`), `log`, `diff`, `commit` (`git add -A` + `-c user.name/email` so no global git config is required), `push`/`pull`, `checkout`/`createBranch`. Push accepts an optional PAT that's spliced into the remote URL **per-call only** (`withToken()`) — never written to disk or the DB. git stderr is surfaced verbatim in API error responses (e.g. a real `403 Permission denied` or a non-fast-forward pull) instead of a generic 500.

### Save modes
Three modes, switchable anytime from the Git panel, persisted server-side (`repos.save_mode`): **Save locally** (fs write only), **Save to Git — manual** (fs write; user stages/commits from the Git panel), **Save to Git — auto** (fs write → auto-commit using a `{file}`/`{time}` message template → optional auto-push). Merge conflicts are surfaced as a status banner (`conflicted` porcelain code) rather than a full 3-way merge UI — resolve the `<<<<<<<`/`=======`/`>>>>>>>` markers directly in the editor, then commit.

### UI (`src/components/editor/*`)
- `FileExplorer.tsx` — lazy nested tree, right-click context menu (new file/folder, rename, duplicate, delete → trash, upload, download), drag-and-drop move.
- `GitPanel.tsx` — save-mode selector, branch switch/create, pull/push, status list → click for a colorized diff modal, commit box, commit history.
- `SearchPanel.tsx` — find-in-files (`/api/repos/:id/search`) and plain-text replace-all across the matched files.
- `TrashPanel.tsx` — lists soft-deleted entries (name, original path, size, age) per repo with **Restore** (moves back to its original path, blocked if something now occupies it) and **Delete forever** (permanent purge), plus an **Empty Trash** action. Activity-bar badge shows the live count. Entries beyond a 200-per-repo cap are purged oldest-first on each new delete; a repo's trash is fully wiped when the repo itself is deleted.
- `StatusBar.tsx` — branch, sync state (↑ahead/↓behind), save mode, cursor position, language mode, editor theme toggle (light/dark, independent of the app's dark shell).
- Monaco (`@monaco-editor/react`, loaded from CDN — no bundler/webpack config needed) supplies minimap, folding, bracket matching, multi-cursor, and built-in IntelliSense for TS/JS/JSON/CSS/HTML for free.
- Ctrl/Cmd+S saves regardless of focus; open tabs, theme, autosave, and save-mode prefs persist per-repo in `localStorage` across sessions.

### Verified (express, live)
Cloned `octocat/Hello-World`, then over the real API: wrote/created/duplicated/renamed/deleted files, confirmed a traversal attempt is rejected, read `git status`/`branches`/`diff`/`log`, committed, created + checked out a branch, attempted an unauthorized push (got a genuine `403` from GitHub, proving it's real git not a stub), then deleted the repo and confirmed the git clone's workspace directory was removed from disk while a **local**-source workspace's real folder was left untouched on delete.

### Known limitations (by design, not started)
No integrated terminal, no LSP-backed cross-file IntelliSense (Monaco's built-in per-language service only), no OAuth device flow (PAT-only auth, entered per-session and never persisted), no 3-way merge conflict editor (conflicts are surfaced, not auto-resolved), find/replace-across-files is plain-text (no regex).

## M7 — AI Assistant (opt-in, two backends, BUILT)

A chat panel in the Editor tab (`src/components/editor/AssistantPanel.tsx`) with **two independent, swappable backends**. Off by default — the activity-bar icon only appears once at least one is configured. Unlike the deterministic swarm above, this one feature calls an LLM (either a hosted one or one running on your own hardware).

```
GET  /api/repos/:id/assistant            -> { providers: { claude: boolean, local: boolean } }
POST /api/repos/:id/assistant  { message, provider? }
  -> text/event-stream of AssistantEvent frames: tool_call/tool_result (interleaved),
     text (assistant reply), done (cost/turns) | error
```
`provider` defaults to Claude if configured, else the local model. If both are configured, `AssistantPanel` shows a small selector; switching starts a fresh conversation (a Claude history and a local-model history are unrelated — never merged).

### Backend 1 — Claude (`src/lib/agents/assistant.ts`)
Runs `@anthropic-ai/claude-agent-sdk` **in-process** against the repo's live workspace directory. Gated on `ANTHROPIC_API_KEY` (`aiAssistantConfigured()`), exactly like GitHub sign-in. One live `Query` per repo, kept open across chat turns via the SDK's streaming-input mode (same "no external queue, in-process state" model `store.ts` uses for jobs) — multi-turn memory without ever writing a transcript to disk (`persistSession: false`). Capped at `maxTurns: 40` / `maxBudgetUsd: 5` per session.

### Backend 2 — any OpenAI-compatible local model (`src/lib/agents/localAssistant.ts`)
No vendor SDK exists for arbitrary local models, so this hand-rolls the same shape of agent loop directly against a plain HTTP `/chat/completions` endpoint: send messages + tool schemas, execute any requested tool calls, feed results back as `role: "tool"` messages, repeat until the model returns plain text. Speaks the OpenAI-compatible wire format that Ollama, LM Studio, llama.cpp's `server`, vLLM, and text-generation-webui all implement. Gated on **both** `CG_LOCAL_LLM_BASE_URL` and `CG_LOCAL_LLM_MODEL` being set (`localLlmConfigured()`). Conversation history lives in an in-process `Map<repoId, ChatMessage[]>` (mirroring the Claude session map, but hand-built instead of SDK-managed). Capped at `MAX_TOOL_TURNS = 20` to bound a buggy/adversarial local model's loop; a local model's function-call JSON is validated defensively per-argument before any tool runs (unlike the Claude SDK's own zod-validated `tool_use`, nothing upstream guarantees a local model's tool-call JSON is well-formed).

**Tool surface (the whole security story, shared by both backends):** the Claude backend gets `tools: []` (every built-in Claude Code tool disabled — no Bash, no raw Read/Write/WebFetch), `strictMcpConfig: true`, and `settingSources: []` (no CLAUDE.md, hooks, or plugins); the local backend never had a built-in toolset to disable in the first place. Both backends' only capabilities are the same nine tools — `list_directory`, `read_file`, `write_file`, `create_entry`, `rename_entry`, `search_workspace`, and (git workspaces only) `git_status`/`git_diff`/`git_commit` — whose actual implementation lives once in `src/lib/agents/workspaceToolImpls.ts` (`buildWorkspaceToolImpls`/`buildGitToolImpls`) and is merely wired up two different ways: as zod-schema `tool()` defs for the Claude Agent SDK's MCP transport, and as OpenAI-style JSON-schema function defs + a name-dispatched runner for the local loop. Every implementation is a thin wrapper over the same path-safe helpers the human-facing Editor already uses (`workspace.ts`'s `resolveSafe`-guarded fs ops, `gitops.ts`'s argv-only git wrapper) — a prompt-injected or hallucinated path can't escape the workspace root any more than a malicious click in the FileExplorer could, regardless of which model is driving the chat.

**Editor integration:** a successful `write_file`/`create_entry`/`rename_entry` triggers `onFileTouched` → `CodeEditor` silently reloads any open, **non-dirty** tab for that path from disk (never clobbers unsaved user edits) and bumps `refreshToken` to refresh the FileExplorer/Git panel. Provider-agnostic — works the same regardless of which backend produced the edit.

### Verified
**Claude:** indexed `octocat/Hello-World` (git workspace) with `ANTHROPIC_API_KEY` set, then over the real API/UI: confirmed the AI Assistant icon is hidden with no provider configured and appears once one is set, sent a live chat message that round-tripped through a real spawned Claude Code subprocess + our MCP tool registration + SSE streaming, and confirmed an upstream auth failure surfaces as a normal in-chat message rather than crashing the request or the server.
**Local model:** ran a minimal mock OpenAI-compatible server and pointed `CG_LOCAL_LLM_BASE_URL`/`CG_LOCAL_LLM_MODEL` at it (no `ANTHROPIC_API_KEY` set) — confirmed `GET .../assistant` reports `{claude:false, local:true}`, a chat POST with no explicit `provider` auto-selected local, executed a real `list_directory` tool call against the live workspace, fed the result back, and returned final text through the actual Next.js SSE route (not a unit-test bypass).
Path-traversal rejection, the exact hasGit-gated tool set, and the shared tool implementations are locked by `tests/assistant.test.ts` (Claude-side tool wrappers). The local agent loop itself — multi-turn tool-calling, malformed-tool-call-JSON handling, the `MAX_TOOL_TURNS` safety cap, HTTP-error graceful degradation, and conversation persistence across turns — is locked by `tests/localAssistant.test.ts`, driven against a real in-process HTTP mock server (no network, no external model server required).

### Known limitations (by design, not started)
No inline diff/approval UI for assistant edits (writes land immediately, same trust level as the human editor); no per-user rate limiting beyond Claude's per-session budget cap (the local backend has no cost to cap); conversation history is in-memory only (lost on restart); local-model tool-calling reliability depends entirely on the chosen model — small or non-tool-tuned models may narrate a "tool call" in prose instead of actually invoking one, which this app cannot detect or correct.
