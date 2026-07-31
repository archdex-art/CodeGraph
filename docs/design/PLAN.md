# CodeGraph — Delivery Plan

| | |
|---|---|
| **Version** | 2.0 — supersedes HLD §17 |
| **Date** | 2026-07-30 |
| **Governed by** | [`IDENTITY.md`](./IDENTITY.md) — binding |
| **Companions** | [`HLD.md`](./HLD.md) · [`LLD.md`](./LLD.md) · [`DETECTION_ENGINE.md`](./DETECTION_ENGINE.md) · [`SPIKES.md`](./SPIKES.md) |

---

## 0. What changed and why

Two inputs forced a resequence, not a restructure.

**1. Prior-art scan (repowise, AGPL-3.0, ~4.3k stars).** A well-executed adjacent product ships
a defect-validated health score, git intelligence, an auto-wiki, and MCP tooling across 15
languages. Their own FAQ states, twice, that they do not and will not rewrite code:

> *"repowise explains, it never rewrites your code."*

Read correctly, that is not a threat. It is a competitor with resources examining verified
remediation and declining to build it. **The analysis layer is commoditising; the remediation
layer is unoccupied.** CodeGraph should therefore reach its differentiator sooner and stop
treating detection breadth as the critical path.

**2. A sequencing fact that was hiding in plain sight.** The four-gate verification harness
(ADR-005) is **completely independent of what produced the finding**. It operates on a patch and
a sandbox. It works against the three fixers that already exist. It was scheduled behind two
phases of detection work for no reason other than document order.

That is why P3 and P4 swap, and why a new score-credibility phase appears.

### Licence boundary — hard constraint

repowise is **AGPL-3.0**. CodeGraph is **MIT**. Published methodology (their guides, their blog,
their validation study) is fair to learn from and is cited where used. **No AGPL code may be
copied, adapted, or vendored** — doing so would force CodeGraph to relicense. Any contributor
consulting their repository for implementation detail should stop and consult the paper trail
instead.

---

## 1. Status

| Phase | Theme | State |
|---|---|---|
| P0 | Safety fixes | ✅ done — 5 fixes, 326 tests green |
| P1 | Extract the seams | ✅ **done** — 9 packages; A′ landed with the §2 correction; 533 tests |
| P2 | Work off the request path | 🟡 **in progress** — queue + `jobs` package done (21 + 16 tests); `apps/worker` next |
| P3 | **Make `verified` mean something** | ⬜ *(was P4)* |
| P4 | **Score credibility** | ⬜ *(new)* |
| P5 | Detection engine | ⬜ *(was P3)* |
| P6 | Scale & incrementality | ⬜ |
| P7 | Surface honesty | ⬜ |

Landed since this plan was written, all on `p1/extract-seams`:

| Commit | What |
|---|---|
| `b919aec` | Health Score ranking inversion (B2), volume damping (B3), fleet N+1 (B7), `projectScore` simulation (C5), desktop CI (C6) |
| `c0bb12b` | Judge calibration — every finding was landing in P0/P1; bands now sit at priority midpoints |
| `6bf7f01` | Desktop e2e unblocked; **stopped shipping the operator's database and cloned repos inside the .dmg** |
| `ad5be8e` | `jobs` table → real queue (LLD §8.1/§8.3): lease, reclaim, attempts, idempotency |
| `5a5a12f` | `@codegraph/jobs` — lease/heartbeat/retry policy |
| `26fd72b` | `vcs` git acquisition (closes the P1 `child_process` gap) |
| `13bd3ec` | `core-graph`; fixed a silent-empty-extraction bug the `any` had hidden |
| `9f7cc75` | `analysis` + `analysis-model` |

---

## 2. P1 completion — the A′ amendment

P1 hit a genuine conflict: `apps/worker` cannot import `apps/web` (`.dependency-cruiser.cjs:112`),
but `indexRepo` still lives there. HLD §17 shows no P2→P3 edge; there is one, and it is now
recorded here.

Measured: `indexer.ts` is 901 LOC with 5 exports, importing only `./types`,
`./codeintel/graph`, `./codeintel/extractors`, `./eslintSecurity` — plus the already-extracted
`@codegraph/config` and `@codegraph/vcs`. That closure is 2,437 LOC, and it is **three
concerns, two of which already have homes.**

| Move | Destination | Nature |
|---|---|---|
| `types.ts` symbol-graph types | `core-graph` *(new)* | §3's charter names exactly these; `graph`/`query`/`extractors` are their only consumers |
| `types.ts` v1 output models (`Dimension`, `Issue`, `IndexResult`, viz/tree/module) | `analysis-model` *(new, transitional)* | **not `core-domain`** — see the correction below |
| `cloneRepo`, `resolveLocalDir`, `cleanup`, churn scan | `vcs` *(exists)* | **closes a P1 gap** — `indexer.ts:1,4,99,452` called `execFile`/`execSync`, contradicting "only `vcs` may use `child_process`" |
| `codeintel/{graph,query}.ts` + `extractors` + `ast-extractor` | `core-graph` *(new)* | clean seam; name stays correct through P5. The extractors come too: `graph.ts` imports `extractorFor` while `indexer.ts` imports `graph.ts`, so splitting them yields `core-graph → analysis → core-graph` |
| rest of `indexer.ts` + `eslintSecurity` | `analysis` *(new, **transitional**)* | P5 splits it |

All four get re-export shims in `apps/web/src/lib/` per LLD §13.1 step 1, so all 36 `types.ts`
importers stay untouched and tests stay green — verified: 533/533 with no test edits.

### Correction: `types.ts` cannot go to `core-domain`

This table originally routed it there, on the correct observation that it is 318 lines of pure
dependency-free models. **The blocker is not structural, it is semantic:** `core-domain` already
declares the v2 taxonomy and the two have diverged.

| | `core-domain` (v2) | `types.ts` (v1, live) |
|---|---|---|
| `Dimension` | **6** members, includes `"performance"` | **5** members, no `"performance"` |
| `DimensionScore` | `findingCount`, all `readonly` | `issueCount`, mutable |

Merging them is a **scoring change**, not a tidy-up. `scoreIssues` enumerates dimensions from
`Object.keys(DIMENSION_META)` and computes the overall score as `Σ score × weight`, and those five
weights sum to exactly 1.0 (0.26 + 0.24 + 0.22 + 0.16 + 0.12). Adopting the six-member type makes
`DIMENSION_META` a type error until a sixth entry exists, and giving `performance` a weight means
taking it from the other five — moving **every repository's Health Score**. P1 and P2 are
structural.

`"performance"` is also not missing by oversight: it is an **agent**, not a scored dimension. The
swarm's `Finding` carries `agent: AgentId` and has no `dimension` field at all
(`lib/agents/types.ts:14`), so the performance specialist already reports without a weight.
**Whether it earns one, and taken from where, is a §5.1 pillar-split question** — which is exactly
where this plan puts it. The v1 models therefore travel to `analysis-model` and P4/P5 migrate
callers onto `core-domain`'s.

`analysis-model` is separate from `analysis` for a reason found by a build failure, not by
argument: `lib/types.ts` re-exports `DIMENSION_META`, a **value**, so Turbopack must resolve its
module — and with the models inside the pipeline package that pulled `node:child_process` (via
`vcs`) and `fs` (via `eslint`) into a `"use client"` component, failing the build with *"the
chunking context does not support external modules"*. Splitting `DIMENSION_META` itself was the
wrong fix: the report UI renders `weight {Math.round(meta.weight * 100)}%`, so the weights are
user-visible — that is §1's explainable Health Score, not an internal detail.

**Naming rule applied:** the transitional package is `analysis`, **not** `score-engine`.
`scoreIssues` is one of five exports; the file also clones, walks, extracts imports, runs the
rule array, and builds the viz graph and tree. A package whose name describes a fifth of its
contents misleads every reader until P5 dismantles it, and you pay the move twice. Its README
states plainly: *"transitional — P5 splits this into pipeline / viz / detect-engine /
score-engine per LLD §13."*

**Exit:** `npm run typecheck && npm run depcruise && npm run test && npm run build` green from
the root; Docker smoke green at `--memory=512m --cpus=0.5`.

---

## 3. P2 — Work off the request path *(~1.5 weeks)*

Unchanged in intent (HLD ADR-001). Now unblocked by §2.

- `jobs` package: SQLite-backed queue, atomic lease-with-reclaim (LLD §8.3), heartbeat, retry,
  `idempotencyKey`, poison-pill quarantine.
- `apps/worker`: poll loop, `AbortSignal` through `PipelineContext`, per-repo mutex, graceful
  shutdown. Killed and respawned per job — this is what reclaims the tree-sitter WASM heap.
- `POST /api/runs` → `202 {runId}`; SSE progress; `/fix` and `/agents` become enqueue endpoints.
- Delete `CG_TREE_SITTER_MAX_RSS_BYTES`. Process exit makes it unnecessary.

**Exit:** p99 route latency < 500 ms excluding SSE; killing the worker mid-job requeues it and
leaves the web tier serving; two concurrent index jobs survive the 512 MB smoke test.

---

## 4. P3 — Make `verified` mean something *(~2 weeks)* ⭐ **moat**

Promoted ahead of detection. Needs no detection work whatsoever.

Review item C3 stands: `verified = after.score >= before.score` is graded by the metric the fix
was built to move. Four gates replace it (ADR-005):

| Gate | Implementation | Skips when |
|---|---|---|
| 1 · syntax | re-parse the edited file; zero parse errors | never |
| 2 · types | `tsc --noEmit` / equivalent | no type config |
| 3 · **tests** | run the repo's suite — network off, timeboxed, memory/pid capped | no test script, or host cannot isolate |
| 4 · re-analysis | **the target finding's fingerprint is gone**, no new findings | never |

Gate 4 checks a *fingerprint*, not the aggregate score. "The score went up" is not evidence that
*this* finding was fixed.

**CLI-first, per [`SPIKES.md`](./SPIKES.md) §2.** Render staff confirm no privileged containers,
so gate 3 cannot run on the hosted demo. `codegraph fix --verify` runs where the developer's test
suite already runs, with their dependencies installed and their own isolation call. Render reports
`verified: partial`; CLI, desktop, and self-hosted Docker report `verified: full`. The UI must
render the two distinctly.

Also in scope:
- `POST /api/findings/:id/fix` takes a **findingId** (review C1). `FixProvider.handles: [ruleId]`
  binds a fixer to the rule it fixes.
- Fix edits become **range-based `TextEdit`s over the AST**, not line deletions (review B1's
  structural cure — the P0 guard was a patch).
- Publishing is a separate request requiring `confirmed: true` (review C4).

**Exit:** 100 % of emitted patches carry a `findingId` and a `VerificationRecord`;
`cg_verification_total{gate,outcome}` on the metrics endpoint; a deliberately-broken fix is
caught by gate 3 in a test.

---

## 5. P4 — Score credibility *(~2.5 weeks)*

The Health Score is the headline metric and is currently `100·exp(-k·penalty/sizeFactor)` with
`k = 0.06` — a hand-picked constant. "Defect-validated" is becoming table stakes for anyone
publishing a code-health number. This phase converts the score from a claim into a measurement.

### 5.1 Split into pillars — never blend

Three independent weight tables over one scoring kernel. **Defect risk** is the surfaced number;
**maintainability** and **performance risk** are co-equal, separately reported, and never
averaged in. A golden test locks the surfaced score byte-for-byte so the pillars cannot bleed.

### 5.2 Add organisational signals

> **Status 2026-07-30: computed, not surfaced.** Eight signals come out of one `git log` pass.
> **`churn` is consumed** (per-issue, and by the swarm's hotspot ranking). The other seven —
> `coChangeScatter`, `changeEntropy`, `ownershipRisk`, `busFactor`, `knowledgeLoss`,
> `priorDefect`, `ageVolatility` — are on `IndexResult` and **nothing reads them**.
>
> They were built to feed §5.3's calibration, which ADR-009 deleted. They are retained rather
> than removed on a narrow argument: they ride a git pass `churn` already requires, so their
> marginal cost is ~0, and they are facts about *the repo in hand* — not a corpus of other
> people's projects, which is what ADR-009 actually objected to.
>
> **That argument expires.** Retaining working code because it is cheap is one step from
> retaining it because it exists, which is the pattern this branch removed five times (dead lint
> gate, unpopulated `coverage_json`, `bin` pointing at nothing, `@codegraph/calibrate`). They
> earn their place by being **shown to a user** — ownership and bus factor are codebase
> visibility, which is the product — or they follow the corpus out. No third option, and not
> "used for scoring": ADR-009 is why unvalidated weights do not ship.

Currently the scorer has churn and nothing else. Organisational git markers are cheap — all
derivable from **a single `git log` pass** — and worth adding:

> **Corrected 2026-07-30, and the correction matters.** This section previously claimed
> repowise's calibration "finds git/organisational markers among the strongest predictors,
> **above static complexity**". That is not what repowise publishes. Their own description of
> the 21 signals leads with complexity: *"complexity, hidden coupling, missing tests, churn,
> fragile ownership"* (repowise.dev, retrieved 2026-07-30). Static complexity and test coverage
> are **in** their model, not beneath it.
>
> The mistake was not harmless. It licensed a git-only feature set, and §5.3's fit against a
> 12-repo corpus then produced a model that loses to `sort by lines-of-code` — see
> `benchmarks/calibration/scorecard.json`. Measured against the reference: repowise reports
> **0.74 cross-project AUC** over 21 repos and 9 languages, "beats recency and past-breakage
> heuristics by 10+ points"; this project's git-only model reaches 0.604 pooled / 0.657
> mean-per-repo and beats neither. The gap is a feature-class gap, not a refutation.

`co_change_scatter` · `change_entropy` · `ownership_risk` · `bus_factor` · `developer_congestion`
· `knowledge_loss` · `prior_defect` · `code_age_volatility`

Plus the fixes already identified: symbol-level blast radius (review B2), logarithmic volume
damping instead of the `hits >= 5` cap (B3), and actually *using* the `confidence` the scorer
stores and ignores.

> **`confidence` done 2026-07-30.** `expectedHarm()` in `packages/analysis/src/indexer.ts` is now
> `severity × blast × volume × confidence`, and both the score and the displayed issue order call
> that one function rather than two expressions kept in step by a comment.
>
> Multiplying is an expectation, not a tuned weight, so it needed no corpus — and the rule table
> establishes the two axes are independent rather than assuming it: `Use of eval()` and `Possible
> hardcoded secret` are BOTH severity 5, so severity means *impact if real* and is not already
> discounted for uncertainty.
>
> **Scores rise** — express 74 → 77, security 45 → 52, concentrated on the low-confidence rules
> where it should be. `k = 0.06` was deliberately NOT rescaled to hold the old headline. The
> golden table moved by exactly `100·(s/100)^0.9` on a uniform-0.9 fixture, hand-verified before
> the numbers were touched, and the transformation law is now asserted so the *semantics* are
> locked and not merely the outputs.
>
> Still open, and NOT closed by this: HLD §8.3's degradation ladder says `lexical`-tier findings
> are "marked low-confidence", but nothing sets confidence from tier. Until it does, the ladder's
> confidence claim is decorative. This change is what would make wiring it mean something.

### 5.3 Calibrate against a defect corpus

Standard defect-prediction methodology, applied honestly:

1. **Corpus.** ~15 OSS repos across the supported languages. Label a file defective if a
   bug-fix commit touched it inside a 6-month window (identify bug-fixes by
   issue-link/`fixes #`/revert patterns, hand-audited on a sample).
2. **Leakage control.** Score each file at **T0 — the commit immediately before the window
   opens.** Scoring inside the window lets the fit see its own answer. This is the step that
   is easiest to get wrong and hardest to detect afterward.
3. **Fit.** L2-regularised logistic regression, **NLOC as an explicit control**, so each marker
   earns weight only for lift *beyond file size*. Ship the learned constants only — no model, no
   inference at runtime, no LLM.
4. **Report.** Cross-project ROC AUC with a confidence interval, plus per-repo. Compare against
   two baselines that must be beaten: recent-churn, and prior-defect.
5. **Gate.** Committed scorecard; CI fails on regression beyond tolerance. Quality change shows
   up as a diff in a PR.

### 5.4 Publish coverage alongside (ADR-008)

A score over 40 % analysed LOC is a different claim from one over 98 %, and must never render
identically.

**Exit — AMENDED 2026-07-30, see [ADR-009](./ADR-009-score-calibration.md).**

> The original exit was *"cross-project ROC AUC published with CI, beating both baselines"*.
> **Retired.** It measured whether weights learned from other people's repositories transfer to
> yours — the question a product shipping one universal model must answer. CodeGraph indexes
> **one repo deeply** (HLD §2.2) and holds its whole history, so it never wears that handicap.
> The measured failure was base-rate non-transfer across projects, which cannot occur within a
> single repository; per-repo discrimination was already 0.86–0.90 on several repos even with
> foreign weights.
>
> Adopting a competitor's headline figure as an exit criterion is reactive positioning
> (IDENTITY.md §4.4) in methodology rather than in copy. That is the actual error, and ADR-009
> records it.

Now:
- Pillar separation locked by golden test — **done** (§5.1).
- Coverage published alongside the score — **done** (ADR-008).
- `projectScore()` re-runs the real scorer rather than the `P0×2.2 + P1×1.1` guess — **done**
  (review C5), and now refuses to project from a truncated issue list.
- The Health Score **discloses that its kernel is hand-picked**. No accuracy claim is made,
  because none is earned.
- Per-file risk ranking is validated **against the indexed repository's own history** — a
  per-repo claim the user can check on their own code, needing no corpus of other people's
  projects. The cross-repo corpus and fitting pipeline are **deleted**; ADR-009 keeps the
  measurements and the reasoning.

> **Identity guard.** Health Score stays **0–100 and stays the only headline number.** No 1–10
> scale, no A–E ladder, no quality gate, no borrowed marker names. Calibration methodology is
> public technique; another product's metric shape is not ([`IDENTITY.md`](./IDENTITY.md) §4.2).

---

## 6. P5 — Detection engine *(~3 weeks)*

Now additive rather than critical-path. Full design in
[`DETECTION_ENGINE.md`](./DETECTION_ENGINE.md); the `analysis` package splits here into
`pipeline` / `viz` / `detect-engine` / `score-engine` / `lang-*` per LLD §13.

Sequenced by value-per-week:

1. **L2 structural matching** — route the 12 regexes through graph-shape rules. Eliminates the
   comment/string/multi-line false positives outright.
2. **CFG + def-use + intraprocedural taint with sanitizers.** The sanitizer category is the
   single largest false-positive reducer and is entirely absent today.
3. **Rules as data** in CodeGraph's own graph vocabulary + the precision/recall benchmark
   harness.
4. **Bounded interprocedural taint** — function summaries across exact call edges, depth ≤ 3.
   The ≤3-hop bound is independently corroborated: repowise reports 96–100 % precision on
   interprocedural N+1 detection using the same depth limit.
5. **SARIF export** at the boundary — never the internal model (ADR-006).

**Exit:** precision ≥ 0.85 overall and ≥ 0.90 for anything emitting at P0; recall ≥ 2× v1 on
injection classes; regex tier demoted to an explicitly low-confidence fallback.

---

## 7. P6 — Scale & incrementality *(~2 weeks)*

Content-addressed per-file cache (`contentHash + extractorVersion → FileFacts`); PR-scoped and
baseline modes off the `fingerprint` column; blob split so `getRepo()` stops parsing ten JSON
columns per call (review B7's `/api/fleet` fan-out).

**Exit:** warm re-index ≤ 5 % of cold; "new findings since main" works; `/api/fleet` no longer
loads full detail per repo.

---

## 8. P7 — Surface honesty *(~1 week)*

`desktop/` into CI or onto a branch, explicitly. Status labels — `stable` / `beta` /
`experimental` — on Fleet, Timeline, CLI, desktop. `ARCHITECTURE.md` reconciled with reality
(review C6). Every README claim mapped to a passing test.

---

## 9. Prior art — what was taken, and what was refused

Recorded so the reasoning survives, per [`IDENTITY.md`](./IDENTITY.md) §3.

### Adopted — technique

| From | What | Where |
|---|---|---|
| Defect-prediction literature; repowise's published study | Calibrate weights against a labelled corpus; score at T0 to prevent leakage; control for NLOC; report ROC AUC vs baselines | §5.3 |
| repowise | Keep defect / maintainability / performance as separate pillars rather than one blended number | §5.1 |
| repowise; SE literature | Organisational git markers as first-class predictors, from a single `git log` pass — **but alongside complexity and test-coverage markers, not instead of them**. repowise's 21 signals are "complexity, hidden coupling, missing tests, churn, fragile ownership"; an earlier version of this row implied git markers ranked above static complexity, which they do not claim | §5.2 |
| repowise | Bounded ≤3-hop call-graph walk for interprocedural analysis — corroborates our own depth bound | §6 |
| Bazel/Turborepo | Content-addressed caching keyed on content, not mtime | §7 |
| repowise `doctor --repair`; general practice | Multi-store consistency check with auto-repair; checkpointed resumable jobs | §4, §7 |

### Refused — identity

| Refused | Why |
|---|---|
| 1–10 score scale | Health Score is 0–100 and is ours. §4.2 |
| Their marker names (`brain_method`, `bumpy_road`, `god_class`, …) | Another product's vocabulary — and several appear borrowed from CodeScene in turn, which is visible in their own comparison pages. §4.5 |
| MCP server, auto-wiki, agent provenance | Their product. Chasing it makes CodeGraph a worse version of a thing that already exists. §4.6 |
| "vs Competitor" comparison pages | Exactly the reactive positioning §4.4 bans. State what CodeGraph is, first and completely. |
| Any of their **code** | AGPL-3.0 vs our MIT. Methodology from published docs only. |

### The strategic read

repowise is strong, well-resourced, and expanding fast across the *analysis* layer — languages,
MCP tooling, hosted tiers. CodeGraph will not win there and should stop trying to.

It twice declines, in writing, to touch remediation.

**That is the whole plan in one sentence: get to the verified fix faster, and let detection
improve underneath it.**
