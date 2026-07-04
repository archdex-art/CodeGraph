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
