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
Every path is resolved with `resolveSafe()` and rejected if it would escape the workspace root (`WorkspacePathError` → 400) — verified live against a `../../../etc/passwd` traversal attempt. Ops: `list` (lazy, one directory level), `read` (binary-sniffed, size-capped at 4MB), `write`, `create` (file/dir), `rename`/`move`, `duplicate`, `upload` (base64 → bytes), `download` (raw byte stream). `DELETE` removes a subtree but refuses to delete the workspace root itself.

### Git (`src/lib/gitops.ts`, `/api/repos/:id/git`)
Thin wrapper over `execFile("git", […])` — argv arrays only, never a shell string, so branch names/commit messages/paths can't inject commands. Ops: `status` (porcelain v2 → modified/added/deleted/untracked/renamed/conflicted), `branches` (local + remote, symbolic remote HEAD filtered out via `%(symref:short)`), `log`, `diff`, `commit` (`git add -A` + `-c user.name/email` so no global git config is required), `push`/`pull`, `checkout`/`createBranch`. Push accepts an optional PAT that's spliced into the remote URL **per-call only** (`withToken()`) — never written to disk or the DB. git stderr is surfaced verbatim in API error responses (e.g. a real `403 Permission denied` or a non-fast-forward pull) instead of a generic 500.

### Save modes
Three modes, switchable anytime from the Git panel, persisted server-side (`repos.save_mode`): **Save locally** (fs write only), **Save to Git — manual** (fs write; user stages/commits from the Git panel), **Save to Git — auto** (fs write → auto-commit using a `{file}`/`{time}` message template → optional auto-push). Merge conflicts are surfaced as a status banner (`conflicted` porcelain code) rather than a full 3-way merge UI — resolve the `<<<<<<<`/`=======`/`>>>>>>>` markers directly in the editor, then commit.

### UI (`src/components/editor/*`)
- `FileExplorer.tsx` — lazy nested tree, right-click context menu (new file/folder, rename, duplicate, delete, upload, download), drag-and-drop move.
- `GitPanel.tsx` — save-mode selector, branch switch/create, pull/push, status list → click for a colorized diff modal, commit box, commit history.
- `SearchPanel.tsx` — find-in-files (`/api/repos/:id/search`) and plain-text replace-all across the matched files.
- `StatusBar.tsx` — branch, sync state (↑ahead/↓behind), save mode, cursor position, language mode, editor theme toggle (light/dark, independent of the app's dark shell).
- Monaco (`@monaco-editor/react`, loaded from CDN — no bundler/webpack config needed) supplies minimap, folding, bracket matching, multi-cursor, and built-in IntelliSense for TS/JS/JSON/CSS/HTML for free.
- Ctrl/Cmd+S saves regardless of focus; open tabs, theme, autosave, and save-mode prefs persist per-repo in `localStorage` across sessions.

### Verified (express, live)
Cloned `octocat/Hello-World`, then over the real API: wrote/created/duplicated/renamed/deleted files, confirmed a traversal attempt is rejected, read `git status`/`branches`/`diff`/`log`, committed, created + checked out a branch, attempted an unauthorized push (got a genuine `403` from GitHub, proving it's real git not a stub), then deleted the repo and confirmed the git clone's workspace directory was removed from disk while a **local**-source workspace's real folder was left untouched on delete.

### Known limitations (by design, not started)
No integrated terminal, no LSP-backed cross-file IntelliSense (Monaco's built-in per-language service only), no OAuth device flow (PAT-only auth, entered per-session and never persisted), no 3-way merge conflict editor (conflicts are surfaced, not auto-resolved), find/replace-across-files is plain-text (no regex).
