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
> the scorecard (deleted with the corpus; the numbers are quoted in ADR-009). Measured
> against the reference: repowise reports
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

> **P5 premise corrected 2026-07-30, measured before any of P5 was built.**
>
> P5's exit criterion is "precision >= 0.85 on benchmark", which assumes a labelled corpus.
> For call resolution no corpus is needed: **for TypeScript the compiler IS ground truth for
> what a call refers to**, so the heuristic can be scored against it directly. Done on this
> repository, over the 2,159 calls where both resolvers had an answer:
>
> **The name-based heuristic is already right 98.4% of the time.** All 35 disagreements were
> same-name shadowing, and the checker won every one.
>
> So typed extraction is NOT a precision play - the precision is already there. Two defects in
> how the TS program was constructed meant type-aware resolution was silently losing to the
> fallback (1,094 -> 2,167 hits once fixed), but total call edges moved 1,912 -> 1,914. The
> remaining gap is RECALL, and it is not the checker's to close: 47% of symbols on this repo
> and 89% on express have no inbound edge, and the checker resolved nothing the heuristic
> missed - it added 0 project targets the heuristic did not also find.
>
> **Two different precisions - do not conflate them, as an earlier draft of this note did.**
>
> - **Call-resolution precision** - does an edge point at the right symbol? Measured **98.4%**,
>   with the compiler as ground truth and no corpus needed. This is the graph's correctness.
> - **Detection precision** (P5's actual exit, "≥ 0.85 overall, ≥ 0.90 at P0") - is a reported
>   finding a real defect? A *human* judgement, so it DOES need a labelled corpus. Nothing
>   measured on this branch bears on it, and it is not met.
>
> The graph work above raised resolution and recall. It did not touch detection quality, which
> is what P5 is actually about. The corpus problem for P5 is therefore still open and still the
> thing to settle before building - and unlike §5.3's, this corpus is about *our own findings*
> on a repo we choose, not about other people's repositories, so ADR-009 does not forbid it.
>
> **Recall addressed 2026-07-30, and it was not a resolution problem at all.** Call-site
> attribution required a named enclosing function, so **2,313 of 5,025 resolved calls (46%)**
> were discarded before resolution mattered - the target was already resolved, and then thrown
> away for want of a caller. Source is now a total function: module scope is a node, because a
> module body executes on import (`<module>` in Python, `<clinit>` on the JVM).
>
> | | before | after |
> |---|---|---|
> | call edges (this repo) | 1,914 | **2,529** |
> | symbols with no inbound edge | 612 / 1,303 (47%) | **411 / 1,304 (32%)** |
> | functions reported dead | 276 | **146** |
> | call edges (express) | 38 | **261** |
>
> **Correction, same day.** The line first published here said "roughly 38% of the remaining
> unreferenced set has real call sites". That was `git grep` counting matches inside strings and
> comments. Re-measured on the AST with the checker: of 137 unreferenced functions, the compiler
> finds a real call site for **3 - 2%**. Call-edge recall is essentially closed; the rest are
> exports, entry points and dynamic dispatch. The grep number was wrong in the direction that
> made the remaining work look bigger, which is the flattering direction, so it is corrected in
> place rather than quietly dropped.
>
> **Second pass: references that are not calls.** The extractor recorded only `CallExpression`.
> Measured with the checker: **372 function identifiers in value position** against 6,836 in
> call position. Two classes are unambiguous and now handled - JSX tags (91) and callback
> arguments (41):
>
> | | before | after |
> |---|---|---|
> | components with no inbound edge | **41 / 41** | **6 / 41** |
> | call edges (this repo) | 2,529 | **2,599** |
> | functions reported dead | 146 | **100** |
> | call edges (express) | 261 | **299** |
> | unreferenced (express) | 107 / 174 | **72 / 174** |
>
> Rendering is invoking: React calls the component. Before this every component in a React
> codebase was an isolated node - the single worst graph defect found on this branch, in a
> product whose thesis is that the graph is the product.
>
> **What remains, for whoever picks this up.** The 239 remaining value-position references are
> `PropertyAccessExpression` - `obj.method` held as a value, `fn.bind(...)`, `fn.name`. They are
> ambiguous: some are usages, some are metadata reads. Sizing them needs the same
> checker-as-ground-truth method used above, applied per parent-node kind, BEFORE any code is
> written. The 6 components still unreferenced are Next.js page and layout entry points, which
> genuinely have no in-repo caller and should stay that way.

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

> **P5 item 1 landed 2026-07-30 — rule context gating.**
>
> Each rule now declares the syntactic context in which it can be true, checked against
> comment/string ranges from the TypeScript *scanner*. Measured across every rule match
> beforehand: **35% on express, 64% on this repository** fired where the rule cannot hold.
>
> | | before | after |
> |---|---|---|
> | issues (express) | 87 | **66** |
> | security dimension | 52 | **71** |
> | Health Score (express) | 77 | **82** |
>
> All 21 suppressed findings on express were verified noise by reading them: `eval(` and
> `innerHTML` inside an XSS *test fixture string* in `test/res.redirect.js`, and 16
> `http://localhost:3000` URLs inside `// example:` comments. No true positive was lost.
>
> It is per-rule and NOT blanket comment/string stripping. A `TODO` marker belongs in a
> comment; `@ts-ignore` can only be a comment; a hardcoded `localhost` URL is necessarily a
> string. Blanket stripping would have deleted three rules' true positives.
>
> **Correction 2026-07-30, same day: the first implementation was wrong and suppressed real
> findings.** It drove `ts.createScanner` in a bare `while (scan())` loop, which cannot call
> `rescanTemplateToken` after a `TemplateHead` or `reScanSlashToken` to settle
> regex-versus-division, so it desynchronises at the first `${...}` or `/`. Validated against
> the parser over 4,783 sampled positions: **1,125 (23.5%) were plain code reported as
> `string`** - `process.exitCode = 1;` among them - which SUPPRESSES findings, the exact
> failure direction the module comment claimed to avoid.
>
> The measurement that justified this work was parser-based all along; only the shipped code
> was not. Rewritten on `createSourceFile`: false negatives 1,125 -> 7, false positives 0,
> index cost +13% (2,129ms -> 2,416ms on this repo). Template substitutions are now `code`, so
> a rule can still see `${userInput}`.
>
> **Still open on item 1.** This is the position class, not yet a graph-shape query. `eval(`
> in code is accepted without checking it is a CallExpression whose callee resolves to the
> global `eval` - so `myEval(` style names and shadowed locals are still matched by text.
> That needs the AST rule tier, and the measurement above does not cover it.
>
> **Item 4 (interprocedural taint) is measured and deferred, not forgotten.** Of 148 untraced
> sink findings here, only **30 (20%)** have an argument derived from a function parameter -
> the ceiling for what caller-side propagation could reach - and the examples are build
> scripts and CLI paths that come from argv anyway. Building a 3-hop engine to move at most 30
> findings on a corpus of one repository is the mistake ADR-009 records. It needs a repository
> where layered request handlers are the norm before the yield can be judged.
>
> **Python is deliberately unchanged.** `syntacticSpans` returns `[]` outside the TS family,
> so those files behave exactly as before. A hand-rolled lexer for `#` comments and
> triple-quoted strings would be wrong at the edges, and a wrong span SUPPRESSES a real
> finding - trading false positives for silent false negatives is the worse deal.

> **P5 item 2 landed 2026-07-30 — intraprocedural taint, and it found a real hole.**
>
> `eslint-plugin-security` flags any non-literal argument to a sink and never asks where the
> value came from. Measured on this repository: **170 sink findings, all at one confidence.**
> Classified by provenance:
>
> | verdict | count | meaning |
> |---|---|---|
> | tainted | **2** | reaches a sink from user-controlled input |
> | sanitized | 26 | a source, then a transform or a dominating guard |
> | untraced | 142 | no source found in this function |
>
> **The 2 were a genuine vulnerability in our own code.** `FileSystemService.readFile` and
> `writeFile` passed `request.path` from an Electron IPC message straight to `fs`. The
> `fs:read`/`fs:write` permissions answer "may the renderer touch the disk", never "which
> file" - so any renderer holding one could read or write anything the user could. Fixed in the
> same commit with `FsGrants`: a directory is reachable because the user picked it in the OS
> dialog, mirroring `@codegraph/fsx` on the server side. The analysis now reports both sinks
> `sanitized`, which is the loop this product is supposed to close.
>
> **Taint modulates confidence; it never deletes a finding.** An incomplete source list would
> otherwise become silent false negatives. Because `confidence` already multiplies into
> `expectedHarm`, an untraced sink now contributes about a third of what it did and a tainted
> one outranks its neighbours - the two changes compose without new machinery.
>
> **The CFG half is guard recognition, and it is where the value was.** JavaScript validates
> far more than it transforms: check a predicate, return early, then use the ORIGINAL value.
> No assignment happens, so a def-use walk sees nothing. Adding dominating early-return guards
> took tainted from 6 to 2 - the four dropped were `apps/web/src/app/api/browse/route.ts`,
> guarded on the line above each sink.
>
> **Deliberately excluded.** `process.env` is not a source: it is operator configuration, and
> treating it as one would re-flag exactly the config-driven paths this quietens. A function
> parameter is not a source either - that is item 4, bounded to depth 3. Verdicts join over a
> lattice (`tainted > sanitized > untraced`), so one dirty path wins; global "saw a source" and
> "saw a sanitizer" flags report *sanitized* for `if (a) p = clean(req.x); else p = req.y`,
> which is a false negative.
>
> **Still open.** Sanitizer and source names are a fixed table, not configurable. Guard
> recognition covers early-return only - a guard inside a branch or loop is ignored, chosen so
> the analysis under-claims rather than suppresses.

> **P6 exit criterion corrected 2026-07-30, before building the cache rather than after.**
>
> The stated exit is "warm re-index <= 5% of cold". Profiled first, on this repository
> (303 TS files, ~2.1s):
>
> | phase | ms | memoisable per file? |
> |---|---|---|
> | eslint security | 624 | yes |
> | `ts.createProgram` | 567 | **no** |
> | symbol extraction | 420 | **no** - see below |
> | `getTypeChecker` | 199 | **no** |
> | `syntacticSpans` | 104 | yes |
>
> **5% is unreachable while a TypeScript program is built.** `oldProgram` reuse was measured
> and buys almost nothing: 751ms cold, 734ms with one file changed, **682ms with NOTHING
> changed**. Parsing is reused; binding and checker construction are not. That ~766ms is a hard
> floor of about a third of the index.
>
> **Delivered: 2,205ms -> 1,220ms, 55% of cold**, memoising the two phases that are pure
> functions of a file's own bytes. Symbol extraction is excluded deliberately even though it is
> the third-largest cost: a reference's `resolvedTargetId` names a declaration in ANOTHER file,
> so a content-keyed hit can return a stale edge after that file moves. It needs a dependency
> key, not a content key, and the unsound version trades visible slowness for invisible wrong
> answers.
>
> **The cache pays where re-indexing actually happens** - not users re-opening a repository,
> but the product indexing near-identical trees: `agents/executor.ts` indexes twice per
> remediation to measure the score delta, and `gitops/historicalAnalysis.ts` indexes one
> snapshot per commit for the Timeline.
>
> **Proposed exit, checkable rather than aspirational:** warm re-index <= 60% of cold on the
> same tree, and a documented reason for the remainder. Reaching materially below that means
> making the graph incremental - reusing the program across runs and re-resolving only the
> changed subgraph - which is a different and much larger piece of work than a per-file cache.

> **Dogfood pass 2026-07-30: CodeGraph run on CodeGraph, findings acted on.**
>
> Self score was 68 with the **security dimension at 12**, and the top of the list was one rule
> firing wrongly over and over. Two false-positive classes, both from real code here:
>
> | site | value | why it is not a secret |
> |---|---|---|
> | `apps/web/src/lib/settings.ts:71` | `anthropicApiKey: "assistant.anthropicApiKey"` | a settings PATH |
> | `apps/web/tests/redact.test.ts` | `anthropicApiKey: "sk-ant-BAD-KEY"` | a test fixture |
>
> **Entropy was tried and rejected on evidence.** The fixture `sk-ant-SCOPED-BUT-VALID-KEY`
> scores H=4.18 - ABOVE `AKIAIOSFODNN7EXAMPLE` (3.68) and a 40-char hex digest (3.83). What
> separated all ten samples was a digit: generated credentials have them, hand-written
> identifiers do not. Applied as a confidence multiplier, never a reject, because
> `correcthorsebatterystaple` is a real secret with no digits.
>
> **`detect-unsafe-regex` downgraded 0.85 -> 0.5.** Both instances it reports here were
> measured and neither backtracks - under a millisecond at n=16,000 - while the control
> `/^(a+)+$/` takes 258ms at n=26. The rule is a static over-approximation that flags a shape
> without proving the alternatives overlap, and its confidence now says "look at this" rather
> than "this is true".
>
> Self 68 -> 71, security 12 -> 22. Express 85 -> 89, security 79 -> 91, and its six
> downgraded "secrets" were read: `'keyboard cat'`, `'manny is cool'`, `'some secret here'` -
> all placeholders in `examples/`.
>
> **Accepted, not fixed: `Large file (1259 LOC)` on `packages/analysis/src/indexer.ts`.** It is
> a true positive about work done in this branch - taint policy, tier policy, credential shape
> and the rule table all landed in one file. Extracting the rules and confidence policy into
> `rules.ts` is the obvious split, but it removes roughly 180 lines and the threshold is 600,
> so it would reduce the finding without clearing it. Clearing it means separating the pipeline
> from the scoring model, which is the `detect-engine` / `score-engine` split LLD §13 already
> specifies. Recorded here so the next person inherits the reason rather than the file.
>
> **First slice done 2026-07-30: `score-engine` extracted.** Chosen over the other slices
> because it removes a real COUPLING rather than only moving lines.
> `agents/orchestrator.ts` computes the swarm's projected score by re-running the REAL scorer
> (review C5), which meant importing `scoreIssues` from the indexer - so scoring a hypothetical
> list of findings pulled in the file walker, the ESLint layer, the TypeScript program builder
> and the taint analysis. It now imports `@codegraph/score-engine`, whose only dependency is
> `analysis-model`, and dependency-cruiser enforces that rather than a comment asking nicely.
>
> `indexer.ts` 1,259 -> 1,131. **The finding does not clear**, which was predicted before
> starting: the threshold is 600 and one slice of ~130 lines was never going to reach it. The
> remaining slices - `pipeline/enumerate`, `lang-*`, `detect-engine`, `viz` - are what get
> there. Every published number is unchanged (express 89, projected 89 -> 90, remediation
> 89 -> 95) and the 24-case golden score table moved to the new package intact.

> **Second slice done: `viz` extracted, plus the shared-contract move both remaining slices
> needed.** `ScannedFile` and `LANG_BY_EXT` now live in `analysis-model`. That was the real
> prerequisite: every stage LLD §13 splits out takes a scanned file, so leaving the type inside
> `indexer.ts` would have made each extracted package import the thing it was extracted FROM -
> the coupling the split exists to remove. `LANG_BY_EXT` moved for the same reason, and because
> two copies would let the graph disagree with the language table beside it.
>
> `indexer.ts` 1,259 -> **1,001** across the two slices. Still above 600. `detect-engine` is the
> big remaining one (~415 lines: the rule table, the confidence policies, `analyzeFiles`) and it
> is more entangled than these two - it needs `PipelineContext` from `analysis/src/context.ts`,
> so the abort contract has to move first. `pipeline/enumerate` and `lang-*` follow.
>
> Numbers unchanged again: express 89, projected 89 -> 90, remediation 89 -> 95, 920/920.

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
