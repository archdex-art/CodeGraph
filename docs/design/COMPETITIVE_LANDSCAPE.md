# CodeGraph — Competitive landscape

| | |
|---|---|
| **Status** | Research. Not binding; `IDENTITY.md` is. |
| **Date** | 2026-08-02 |
| **Method** | Competitor claims from pages fetched on the date above. CodeGraph claims verified against the code, not the README. |
| **Confidence** | Marked inline. `[UNVERIFIED]` = could not fetch or read the primary source. `[INFERENCE]` = reasoning, not observation. |

## The short answer to the question that was asked

**What they do better than us:** they are *installed where the work happens*. Sonar, CodeScene, Codacy, DeepSource and repowise all sit on the pull request and gate the merge; CodeGraph has no PR integration at all. Repowise has learned its health weights against a real defect corpus and publishes a cross-project ROC AUC; our confidence numbers are hand-typed constants. Sonar and CodeQL have thousands of rules across dozens of languages with type-aware and interprocedural analysis; we have **14 line regexes plus 10 ESLint AST rules** (`packages/detect-engine/src/detect.ts:168-228`, `eslintSecurity.ts:30-57`), and full AST analysis for the TypeScript family only (`packages/core-graph/src/extractors.ts:46`).

**What we do better than them:** we *finish the job*. Repowise says it outright — "a worklist, not an auto-refactor: repowise explains, it never rewrites." CodeGraph generates a patch and runs the repository's own test suite against it before calling it verified (`apps/cli/src/fix.ts:140`, `testsGate` in `packages/verify/`). We are MIT, single-container, single-SQLite-file, and require **no LLM API key** for the deterministic path. And we are one product with a graph, a score, a swarm and an editor in the same surface — every competitor is one or two of those.

**The uncomfortable finding:** the verified-fix moat is narrower than the README implies. Sonar shipped a Remediation Agent and acquired Gitar, which validates a fix against the project's real CI pipeline and iterates until the PR passes. That is our differentiator, from the incumbent, with the incumbent's distribution.

---

## 1. repowise.dev — the named competitor, and the closest one

**It is real.** `repowize.dev` (with a z) does not resolve; `repowise.dev` does, and it is the nearest thing to CodeGraph in the field. Fetched https://repowise.dev on 2026-08-02.

Open source, self-hostable, Python. `[UNVERIFIED: AGPL-3.0 — reported by a sub-agent whose session died before I could confirm the licence file. Check https://github.com/repowise-dev/repowise before relying on it.]` 4.6k GitHub stars, 5.1k repos indexed, per their own landing page.

| Overlap with CodeGraph | Their version |
|---|---|
| Tree-sitter symbol graph | 10+ languages, PageRank + betweenness centrality, edge types incl. **co-change** |
| Health score | 1–10 from **21 deterministic signals**, no LLM, <30s on 3,000 files |
| Never blend the score | "Three co-equal views per file: defect risk, maintainability, static performance risk, **never blended into one number**" |
| Self-hosted, offline | Yes, plus air-gapped enterprise tier |
| Git history signals | Hotspots, co-change partners, blame ownership |

That third row should be uncomfortable reading: it is nearly verbatim our own pillar design (`pillarsFrom` in `apps/web/src/lib/types.ts`, rendered as "PILLARS · NEVER BLENDED"). `ADR-009` already cites repowise's 0.74 figure, so the team knows them.

### What repowise does that we cannot

1. **A defect-validated score.** "0.74 cross-project ROC AUC… up to 0.90 per repo", "~73% accuracy at calling which file breaks next, proven on 21 real projects across 9 languages", and weights **learned from a real defect corpus, not hand-tuned**. Ours are hand-typed constants that were never fitted to an observed rate of being right — see `DETECTION_RELIABILITY.md` §1.2. **This is the single largest capability gap in this document.**
2. **MCP server — 10 tools.** They serve the index to coding agents directly, and claim −96% tokens to load context (2,391 vs 64,039 on the same task). We have Graph-RAG context generation (`apps/web/src/lib/codeintel/context.ts`) but no MCP surface, so no agent can reach it.
3. **A PR bot with a merge-gating Check Run**, and "0 LLM calls, so the same diff always reviews the same way". Determinism is our argument, deployed at the point of decision, which is not ours.
4. **A generated, confidence-scored wiki with git-informed staleness decay**, and captured architectural decisions that age when the files they govern change.
5. **Public shareable analyses** (`repowise.dev/repo/...`, `/pr/...`) — distribution we have no equivalent of.

### What we do that repowise does not

- **We fix.** They explicitly refuse to. Our swarm proposes a patch and `testsGate` runs the project's suite (`apps/cli/src/fix.ts:140-146`).
- **A built-in editor** with git status, staging, commit and push (`apps/web/src/components/CodeEditor.tsx`), now with an issues panel that opens a finding at its line.
- **MIT vs (probably) AGPL.** For a company that wants to modify and not publish, that difference is the whole decision.

---

## 2. The field

Pricing is as published on the date above and moves constantly.

| | Hosting | Licence | Price | Languages | Graph-aware | Autofix | Fix verified by tests | Works offline / no key |
|---|---|---|---|---|---|---|---|---|
| **CodeGraph** | Self-host | MIT | Free | 6 full AST, ~19 lexical | **Yes, symbol-level** | Yes | **Yes** | **Yes** |
| repowise | Self-host + cloud | OSS `[UNVERIFIED]` | Free / Pro / Enterprise | 10+ | Yes | **No, by design** | No | Yes |
| SonarQube | Both | LGPL (Community) → commercial | Free CE → paid | 30+ | Partial | **Yes (Remediation Agent)** | **Via Gitar** | Community: yes |
| CodeScene | Both | Commercial (free CE for OSS) | €18–27 / active author / mo | 30+ | Behavioural | ACE add-on | No `[UNVERIFIED]` | On-prem: yes |
| Qlty (ex-Code Climate Quality) | Both | Open CLI (Rust) | Free CLI + paid cloud | Many | No | No | No | CLI: yes |
| Codacy | Cloud + self-host | Commercial | Free tier → paid | 40+ | No | Yes | No | No |
| DeepSource | Cloud + self-host | Commercial | Free OSS → paid | ~10 | No | Yes ("Autofix") | No | No |
| Semgrep | Both | LGPL rules / commercial platform | Free OSS → paid | 30+ | Interfile (paid) | Assistant | No | OSS: yes |
| Snyk Code | Cloud | Commercial | Free tier → paid | 10+ | Yes (DeepCode) | Yes | No | No |
| CodeQL / GHAS | GitHub | **Restricted** | Free for public repos; paid GHAS otherwise | 10+ | **Yes, strongest** | Copilot Autofix | No | No |
| Greptile / Sourcegraph | Cloud / self-host | Commercial | Paid | Many | Yes | Review only | No | No |
| Qodo (ex-Codium) | Cloud | `pr-agent` Apache-2.0, platform proprietary | Free → paid | Many | No | Tests + review | Runs generated tests | No |

**Notes on the ones that matter most**

- **Sonar** is the incumbent and has just moved onto our ground. The **Remediation Agent** patches in a sandbox and re-runs *Sonar's own analysis* — which is our gate 4 (re-analysis), not our gate 3 (the project's tests). But Sonar **acquired Gitar**, which validates against the **real CI pipeline** and auto-iterates until the PR passes. That is our gate 3, with better distribution. `[Both fetched from sonarsource.com/products/… on 2026-08-02.]`
- **Code Climate Quality no longer exists as such.** codeclimate.com is now an AI-transformation consultancy; the Quality product spun out as **Qlty** — a free, open Rust CLI. The maintainability-grade market we were positioned against has been vacated and re-entered from below, for free.
- **CodeQL's licence forbids automated analysis of non-open-source code** unless on a paid GHAS plan (`raw.githubusercontent.com/github/codeql-cli-binaries/main/LICENSE.md`). That is a real opening: MIT and self-hosted is a legitimate answer for a company that cannot use the best free analyser on its own private code.
- **CodeScene** is the closest to our behavioural/hotspot angle and is a mature commercial product at €18–27 per active author per month. It has the research pedigree (Adam Tornhill) we do not.

---

## 3. Our differentiators, checked against the code rather than the README

| README claim | Verdict |
|---|---|
| "No LLM API key required" | **True.** The deterministic path — index, detect, score, graph — makes no model call. The swarm's narrative and the assistant are optional and degrade to nothing (`effectiveLocalLlmConfig` returns undefined → `generateNarrative` returns undefined). |
| "Verified fixes — runs your own tests" | **True, and gated.** `testsGate` runs with `allowed: opts.verify`, i.e. only when the user asks for it (`apps/cli/src/fix.ts:140-146`). Worth stating plainly in marketing that it is opt-in. |
| "Blast radius is symbol-level" | **True.** Computed over the symbol graph, not file fan-in — `finding.ts:91` records the fix for review item B2 explicitly. |
| "Explainable Health Score" | **Partly.** It decomposes score → 5 pillars → 5 dimensions → findings, and every finding traces to a file and line. But `expectedHarm` — the per-finding point contribution — is computed in `packages/score-engine` and **never rendered**. A user cannot see "this finding cost you 4 points." That is a one-day UI change and the cheapest credibility win in this document. |
| "One container, one SQLite file" | **True**, and genuinely rare in this field. |
| Confidence shown as a percentage | **Misleading.** See `DETECTION_RELIABILITY.md` — the number is a hand-typed constant multiplied by other hand-typed constants, and nothing has ever measured it. |

---

## 4. Recommendations

Ranked by impact ÷ effort.

### (a) Table stakes we are missing

1. **A pull-request integration.** *Highest ratio in this document.* Every competitor has one, and the Facebook CACM 2019 result cited in `DETECTION_RELIABILITY.md` is that the same analysis has a ~0% fix rate in batch and >70% at diff time. **New `apps/web/src/app/api/webhooks/github/route.ts` + a diff-scoped findings filter in `packages/analysis`.** This is also Stage 5 of the reliability plan — one build, two payoffs.
2. **Show `expectedHarm` per finding.** The score's own arithmetic, already computed, currently discarded. **`apps/web/src/app/repos/[id]/page.tsx`**, one column.
3. **Language parity for the AST tier.** Only the TS family gets `full`; Python is `lexical` and the rest are unanalysed structurally. Tree-sitter grammars are already bundled (`apps/web/wasm/tree-sitter-python.wasm`). **`packages/core-graph/src/extractors.ts`.**
4. **Publish SARIF into GitHub code scanning.** `packages/analysis-model/src/sarif.ts` already emits it; nothing uploads it.

### (b) Bets that widen the gap where we are already strong

5. **An MCP server over the existing Graph-RAG index.** Repowise's headline is −96% context tokens; we have the index and the ranking (`lib/codeintel/context.ts`) and no way for an agent to reach it. **New `apps/mcp/`.** This is the highest-upside item on the list — the graph is the asset, and MCP is the socket every agent already plugs into.
6. **Make `verified` legible.** Nobody else can say "this patch made your suite pass and here is the run." Surface the gate results as an artifact on the finding, not a badge.
7. **Calibrate the confidence number** (Stage 3 of the reliability plan) — or stop printing it as a percentage until it is calibrated. Repowise leads with 0.74 ROC AUC; we lead with a number that means nothing.

### (c) Things competitors do that we should deliberately NOT copy

8. **A single blended letter grade** (Code Climate's A–F, Sonar's quality gate pass/fail). `IDENTITY.md` §4 forbids it and repowise independently reached the same conclusion — "never blended into one number." This is a case where the field agrees with us.
9. **Cross-project learned score weights**, repowise's central claim. `ADR-009` rejected exactly this after measuring it fail, and cites repowise's own 0.74 while doing so. Do not reopen it because a competitor markets it; reopen it only if `ADR-009`'s specific failure is shown not to apply. `DETECTION_RELIABILITY.md` Stage 3 threads this needle by calibrating **per rule mechanism**, not per repository base rate.
10. **LLM-written findings.** Semgrep Assistant and CodeRabbit generate prose explanations; that is the opposite of a deterministic swarm and would make the same diff review differently twice. Repowise makes "0 LLM calls" a selling point on their PR bot. So should we.

---

## 5. What I could not verify

- Repowise's licence, and whether their 0.74/73% figures are reproducible. Their landing page says every number is reproducible on your own codebase; nobody has run it.
- CodeScene's fix-verification behaviour (ACE add-on) — pricing page fetched, product behaviour not.
- Codacy, DeepSource, Snyk Code, Greptile, Sourcegraph and Qodo details come from a sub-agent that returned summaries with URLs but died before I could re-fetch each one. Treat the table's rows for those six as **`[UNVERIFIED]`** and re-check before quoting externally.
- GHAS per-seat pricing: the docs URL 404'd; only the licence restriction was read directly.
