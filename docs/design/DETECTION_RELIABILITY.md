# CodeGraph — Detection Reliability: baseline, state of the art, and a staged plan

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-08-02 |
| **Status** | Research. No code changed by this document. |
| **Governed by** | [`IDENTITY.md`](./IDENTITY.md) — binding |
| **Question this answers** | *What would make CodeGraph's detection **reliable** — precision first, then recall, and above all calibrated so that a printed confidence means something?* |
| **Relationship to [`DETECTION_ENGINE.md`](./DETECTION_ENGINE.md)** | That document asks "how do we detect more, and more precisely?" This one asks "how do we know, and how do we say honestly what we know?" It does not restate the L0→L5 ladder. |

> **Reading note.** Part 1 is derived by reading the code in `packages/` and `apps/web/src/lib/agents/`, and by running the shipped detector on constructed inputs (§1.6). Where the code disagrees with `DETECTION_ENGINE.md`'s description of the code, the code wins and the discrepancy is recorded.

---

## 0. The thesis, in one paragraph

CodeGraph currently prints a number between 0 and 1 next to every finding, calls it `confidence`, multiplies it into the Health Score, and renders it to the user as a percentage (`apps/web/src/components/AgentSwarm.tsx:160`). **That number is not measured. It is a constant typed by whoever wrote the rule, multiplied by up to three other hand-picked constants.** The one honest thing about it is its relative ordering — and even that has never been validated against outcomes. Meanwhile the mechanism that *could* justify a confidence — `ConfidenceBasis` in `packages/core-domain/src/finding.ts:48-53` — exists as a type with five values, of which the live write path emits exactly one, hardcoded (`packages/persistence/src/runs.ts:152`). The highest-leverage reliability work available to CodeGraph is not more detection power. It is making the printed number mean what it says, and having a harness that can tell you when it stops.

---

# Part 1 — Baseline, from the code

## 1.1 Every rule that emits a finding

Five distinct producers feed the `Issue` stream, plus a sixth parallel stream (the swarm) that is scored separately.

### A. Line-regex rules — `packages/detect-engine/src/detect.ts:168-228`

Twelve rules. Each is applied with `rule.re.exec(line)` **once per line** (`detect.ts:362`), so at most one match per line per rule is ever seen.

| # | Title | Line | Mechanism | Sev | Base conf | Context gate | Language gate |
|---|---|---|---|---|---|---|---|
| 1 | Use of eval() | 169 | regex | 5 | 0.95 | `code` | none |
| 2 | Shell/process execution | 170 | regex | 3 | 0.85 | `code` | none |
| 3 | Possible hardcoded secret | 171-176 | regex + `validate` (`isPlaceholderSecret`) + `adjust` (`looksLikeCredential`, ×0.25) | 5 | 0.8 | `code` | none |
| 4 | Hardcoded local URL | 178 | regex | 2 | 0.9 | `string`,`code` | none |
| 5 | Raw HTML injection sink | 179 | regex | 3 | 0.95 | `code` | none |
| 6 | Possible SQL string concatenation | 181 | regex | 4 | 0.7 | `code`,`string` | none |
| 7 | Leftover debug output | 183 | regex | 1 | 1.0 | `code` | none |
| 8 | debugger statement | 201-202 | regex (statement-form) | 2 | 1.0 | `code` | `.ts .tsx .js .jsx .mjs .cjs` |
| 9 | Empty catch block | 203 | regex | 3 | 0.9 | `code` | none |
| 10 | TODO/FIXME marker | 217-218 | regex + `validate` (backtick-parity) | 1 | 1.0 | `comment` | none |
| 11 | Suppressed checker | 225-226 | regex + `validate` (backtick-parity) | 2 | 1.0 | `comment` | none |
| 12 | Untyped `any` | 227 | regex | 1 | 1.0 | `code` | `.ts .tsx` |

The context gate (`contextAt`/`syntacticSpans`, `packages/core-graph/src/source-context.ts`) is the only structural signal in this layer. **It is active only for the TypeScript family** — `TS_FAMILY` at `source-context.ts:22`, and `computeSpans` returns `[]` for everything else, which `detect.ts:365` treats as "no gate" (`if (spans.length && …)`). §1.6 shows the consequence, and it is worse than "Python findings are less trustworthy."

### B. AST security rules — `packages/detect-engine/src/eslintSecurity.ts:30-57`

Ten rules from `eslint-plugin-security`, run through ESLint's `Linter` API with `@typescript-eslint/parser` (`eslintSecurity.ts:67-78`). **JS/TS only** (`JS_EXTS`, line 22). Capped at 10 findings per file (`maxFindings = 10`, line 114). Confidences 0.5–0.9, all constants in the same table. Five of the ten are marked `taintable` (`TAINTABLE`, lines 97-103) and get a dataflow pass; the other five do not.

### C. Metric rule — `detect.ts:409-413`

`Large file (N LOC)` at `loc > 600`, severity 2 or 4 at `loc > 1200`, confidence 0.9.

### D. Project rules — `detect.ts:420-432`

`No test files detected` (sev 4, conf 0.6) and `Low test coverage ratio` (sev 2, conf 0.75), from a filename regex over `CODE_EXTS`.

### E. Dependency hygiene — `packages/analysis/src/indexer.ts:289-380`

Five emitters, at lines 320, 335, 339, 353, 368 — unparseable manifest, unpinned dep (npm), pre-1.0 dep, no lockfile, unpinned dep (requirements.txt). **All hardcoded to confidence 1.0.**

### F. The swarm — `apps/web/src/lib/agents/specialists.ts`

Seven specialists (security, performance, refactor, deadcode, dependency, architecture, test) producing a *separate* `Finding` type (`apps/web/src/lib/agents/types.ts`) with its own confidences at lines 36, 89, 129, 160, 182, 211, 237, 270, 299, 325 — e.g. `0.9 // AST-derived complexity is highly reliable` (line 182), `s.exported ? 0.3 : 0.8` (line 211), `cycle.length === 2 ? 0.9 : 0.7` (line 270). Some are derived from graph evidence (fan-in, exportedness, cycle length); none is derived from an outcome.

**Total: 30 emitters in the index pipeline** (12 + 10 + 1 + 2 + 5), plus the swarm's parallel stream.

### Language coverage, stated plainly

| Capability | TS/JS | Python | Everything else |
|---|---|---|---|
| Regex rules | ✓ | ✓ | ✓ |
| Comment/string context gate | ✓ | ✗ | ✗ |
| AST security layer | ✓ | ✗ | ✗ |
| Taint classification | ✓ | ✗ | ✗ |
| Analysis tier (`tierForExt`, `source-context.ts:43-45`) | `full` | `lexical` | `lexical` |

`AnalysisTier` declares four values (`finding.ts:56`); `tierForExt` can only ever return `full` or `lexical`. `ast` is defined and never produced — `source-context.ts` says so itself.

## 1.2 Structural failure modes, per mechanism

Not tuning problems. Properties of the mechanism.

| Mechanism | Cannot see | Concrete consequence in this codebase |
|---|---|---|
| **Line regex** (12 rules) | Anything spanning two lines; anything about scope, binding, or type | `const evil = eval; evil(x)` is invisible (verified, §1.6). A match is capped at one per line by `exec` without `/g`, so a line with two violations reports one. |
| **Line regex + context gate** (TS only) | Whether the identifier resolves to what the rule means | `{ margin: any }` is "Untyped `any`" (verified). `.query(` is a DB call, a DOM query, or a GraphQL client — indistinguishable. |
| **Line regex, no gate** (Python, Go, everything) | Comment vs. string vs. code | A `# TODO` *inside a string literal* fires the comment-only rule; prose mentioning `eval()` fires the severity-5 security rule (both verified, §1.6). The `context:` field on rules 10 and 11 is **inert** outside the TS family — a silent correctness hole, not merely reduced confidence. |
| **AST query, no types** (eslint-plugin-security) | What a value's receiver or provenance is | `detect-non-literal-fs-filename` flags any non-literal argument. Measured in this repo: **136 of 200 findings from that one rule** (`detect.ts:234-235`). It cannot resolve a method to its receiver, so it cannot distinguish `fs.readFile(cfgPath)` from `fs.readFile(req.query.p)`. |
| **AST shape as proxy for a property** | Whether the shape actually has the property | `detect-unsafe-regex` flags nested quantifiers without establishing that alternatives overlap (`eslintSecurity.ts:31-46`). Both instances in this repo were measured non-backtracking. Confidence was cut 0.85→0.5 in response — an *asserted* correction to an *asserted* number. |
| **Intraprocedural, flow-insensitive taint** (`packages/core-graph/src/dataflow.ts`) | Order, branch feasibility, cross-function flow, aliasing | Documented at `dataflow.ts:12-17`: unions every assignment to a name in the enclosing function, ignoring order and branches. Over-approximates (safe direction) — but a parameter is not a source, so any flow entering through a call is `untraced`, i.e. indistinguishable from "no source exists." |
| **Metric rule** (LOC, test ratio) | Whether the number means anything here | A 700-line generated file and a 700-line god object score identically. |
| **Manifest rule** (deps) | Whether the dependency is reachable, or whether the range is deliberate | Confidence 1.0 asserts the *fact*, which is true; the *finding* ("this is a problem") is not measured at all. |

## 1.3 What `confidence` actually means today

Answered from the code, not the docs.

**It is a constant, multiplied by up to three other constants.** The full pipeline for a regex finding (`detect.ts:374-379`):

```
confidence = rule.confidence            // hand-typed literal, detect.ts:168-228
           × tierPenalty                // 0.45 if lexical, else 1   (LEXICAL_CONFIDENCE_FACTOR, :296)
           × rule.adjust?.(m)           // 0.25 for a non-credential-shaped secret (:105)
           , floored at 0.05            // scaleConfidence, :299-302
```

For an ESLint sink finding (`detect.ts:397-405`):

```
confidence = RULE_META[id].confidence   // hand-typed literal, eslintSecurity.ts:30-57
           × { tainted:   ×1.35 (cap 0.95)     // adjustForTaint, detect.ts:270-283
             , sanitized: ×0.2  (floor 0.05)
             , untraced:  ×0.35 (floor 0.10) }
           × tierPenalty
```

Every factor is a literal. **Not one of them was fitted to, or validated against, an observed rate of being right.** The `0.45` lexical factor is the closest to evidence: it is justified by a measurement that 35% (express) / 64% (self) of raw regex matches sit in an impossible context (`detect.ts:288-291`) — but that measurement is of *context distribution*, not of *finding correctness*, and "a little over half" was then chosen by hand.

The number is load-bearing. `expectedHarm` (`packages/score-engine/src/score.ts:114-121`) is `severity × blastMultiplier × volumeMultiplier × confidence`, and that product is both the Health Score penalty and the displayed ordering. So a hand-typed constant moves the headline number.

**`ConfidenceBasis` is a type with no live producer.** `packages/core-domain/src/finding.ts:48-53` declares five ordered values (`syntactic` → `structural` → `type_verified` → `dataflow_verified` → `corroborated`) and documents them as "the axis the UI uses to decide whether a finding may be shown as certain." The only code that writes the column is `packages/persistence/src/runs.ts:132-159`, which passes the string literals `"syntactic"` and `"lexical"` for every finding, with an honest comment saying why. The v1 `Issue` type (`packages/analysis-model/src/models.ts:138`) has no basis field at all — only `confidence?: number`. So:

- The type is right, and truthfully filled in for v1's actual capability.
- **But an ESLint AST finding, a taint-verified finding, and a regex hit are all persisted as `syntactic`/`lexical`.** The one structural distinction the model can express is being thrown away at the boundary, and the *only* thing that survives to the UI is the unvalidated float.

**The swarm's critic manufactures confidence.** `apps/web/src/lib/agents/orchestrator.ts:93`:

```ts
primary.confidence = Math.min(1, primary.confidence + 0.15 * others.length);
```

Two findings within two lines of each other (`orchestrator.ts:104`) count as corroboration, +0.15 each. This is the `corroborated` idea from `DETECTION_ENGINE.md` §4.6, implemented as addition on a probability scale. Two problems:

1. **Adding to a probability is not a probability operation.** 0.8 + 0.15 = 0.95 asserts a 3× reduction in error odds from one agreement.
2. **The agreements are not independent.** The dependency specialist reads `i.dimension === "dependency_hygiene"` issues (`specialists.ts:232`) and the security specialist reads security-dimension issues — both re-emit the *same underlying regex hit*. Corroboration between two views of one signal is not evidence; it is double counting. The critic groups purely by locus and cannot tell the difference.

## 1.4 What is measured today

`PRECISION_PROTOCOL.md` is genuinely good methodology and should be read before criticising it: pre-registered before sampling (§0), fixed stride so the sample is reproducible (§2.2), sample frozen once drawn (§2.4), `unclear` counted against precision (§3), Wilson intervals (§4), per-rule breakdown (§4), full labels committed. §5 states its own limits before the numbers existed. The held-out design (§8) fixed selection criteria before cloning and **recorded a prediction before running**. That is better than most published tool evaluations.

What it establishes:

| Corpus | n | Precision | 95% CI |
|---|---|---|---|
| express + self, pass 3 | 50 | 88% | 76–94% |
| Held-out (axios, flask, got) | 45 | 87% | 74–94% |

Sample files: `precision-sample.json` (50), `precision-sample-2.json` (50), `precision-sample-3.json` (50), `precision-heldout.json` (45). Verified record shape: `{corpus, title, file, line, src, label, reason}` — `label ∈ {true,false,unclear}`.

**What the protocol supports, and what it does not:**

| Claim | Supported? |
|---|---|
| "Aggregate precision on these five repos is ~87%, ±10 points" | **Yes.** This is measured and the interval is quoted. |
| "Per-rule precision differs sharply and the aggregate hides it" | **Yes**, and this is the protocol's best contribution (§6: 35 of 50 findings came from rules that were right every time). |
| "The pass-2/3 fixes generalise" | **Yes, weakly.** 87% held-out vs 88% tuned, with a prediction recorded in advance. n=45 across three repos. |
| "Precision ≥ 0.85" | **Point estimate yes, interval no**, and §7 says so. |
| "Precision on your repository will be ~87%" | **No.** Five repos, all OSS, four JS/TS + one Python. Self-precision was 56% before fixes and 76% after — a 24-point spread driven purely by corpus. |
| "A finding at confidence 0.8 is right about 80% of the time" | **No.** Nothing in the protocol measures this. It is the claim the product makes on screen and the one claim with zero evidence behind it. |
| "Recall is X" | **No, by explicit design** (§1). No denominator exists. |

**Three gaps the protocol names about itself, all still open:**

1. **One labeller, who wrote the rules** (§5). No second rater, no agreement statistic.
2. **n≈50 per pass.** A Wilson interval that wide cannot resolve a 5-point change.
3. **Nothing is automated.** `npm run bench` (`scripts/bench.mts`) reproduces README *performance* figures against `expressjs/express@a371447`; it does not sample, label, or score precision. `package.json` has no precision target. There is no committed scorecard, so a regression in detection quality is invisible to CI. `DETECTION_ENGINE.md` Part 6 designs this harness; it does not exist.

## 1.5 Where `DETECTION_ENGINE.md` is now stale

Recorded because the doc is the first thing a contributor reads, and its Part 1 describes a detector two refactors old.

| Claim in `DETECTION_ENGINE.md` | Reality |
|---|---|
| §1.1 "`app/src/lib/indexer.ts:383-420`", "Twelve regexes (`indexer.ts:359-377`)" | Moved to `packages/detect-engine/src/detect.ts`. Twelve is still right. |
| §1.1 loop snippet with `if (++hits >= 5) break;` | Superseded: the loop counts past the cap and records `occurrences` (`detect.ts:367-389`); `volumeMultiplier` damps logarithmically (`score.ts:84-87`). |
| §1.3 example 1, `eval()` in a comment | **Fixed.** Context gate suppresses it (verified §1.6). |
| §1.3 example 2, secret inside a doc string | **Fixed** — but by the context gate, not by the placeholder guard the doc credits (verified §1.6). |
| §1.3 examples 4 and 5 (`{ margin: any }`, `${escapeId(id)}`) | **Still live** (verified §1.6). |
| §1.5 "`confidence` is stored and then ignored by `score()`" | **Fixed.** `expectedHarm` multiplies by it (`score.ts:114-121`). |
| §5.1 "Volume handling: hard cap at 5/rule/file" | Fixed; log damping. |
| §5.1 "Quality measurement: none" | Superseded by `PRECISION_PROTOCOL.md` — for precision, manually, not in CI. |

None of this is a criticism of the doc's design content, which stands. It is a warning against quoting its Part 1 as the current baseline.

## 1.6 Measured baseline — probe run 2026-08-02

Constructed inputs, run through the shipped `indexRepo` from `@codegraph/analysis` on this working tree. Verbatim output:

```
src/a.ts:7 [security sev5 conf=0.8]        Possible hardcoded secret
.:1        [test_integrity sev4 conf=0.6]  No test files detected
src/a.ts:4 [security sev4 conf=0.7]        Possible SQL string concatenation
src/b.py:2 [security sev5 conf=0.428]      Use of eval()
src/b.py:4 [security sev4 conf=0.315]      Possible SQL string concatenation
src/a.ts:3 [correctness sev1 conf=1]       Untyped `any`
src/b.py:1 [maintainability sev1 conf=0.45] TODO/FIXME marker
```

Inputs (`src/a.ts`, TypeScript, `full` tier):

| Line | Source | Result |
|---|---|---|
| 1 | `// SECURITY NOTE: never use eval() on user input.` | **No finding** — context gate works. |
| 2 | `const HELP = "Set api_key = 'your-key-here' in .env";` | **No finding** — suppressed by the *context gate* (`string` is not in rule 3's `code` default), not by `isPlaceholderSecret`. |
| 3 | `const style = { margin: any };` | **False positive**, conf 1.0. |
| 4 | ``db.query(`SELECT * FROM users WHERE id = ${escapeId(id)}`)`` | **False positive**, conf 0.7 — sanitizer invisible. |
| 5-6 | `const evil = eval;` / `evil(req.body.code);` | **False negative** — no finding at all. |
| 7 | `apiKey: "sk-ant-api03-x7Kd9mQ2pL4vR8nT1wY6zA3bC5eF"` | True positive, conf 0.8. |

Inputs (`src/b.py`, Python, `lexical` tier — **the important half**):

| Line | Source | Result |
|---|---|---|
| 1 | `HELP = "write # TODO markers in your code"` | **"TODO/FIXME marker" fires from inside a string literal**, conf 0.45. Rule 10 declares `context: ["comment"]`; the gate is skipped entirely because `spans` is empty. |
| 2 | `DOC = "an interactive eval() is available"` | **"Use of eval()", severity 5**, conf 0.428. Prose in a docstring, reported as a critical security finding. |
| 4 | `q = "SELECT * FROM t WHERE id = " + req.args["id"]` | True positive, conf 0.315 — a *real* injection ranked below the two false positives above it by severity×confidence. |

**Three baseline facts this establishes that no document currently states:**

1. **`context:` is not a filter on non-TS files, it is a no-op.** This is the same structural failure that produced `debugger` 0/4 on flask (`PRECISION_PROTOCOL.md` §8), and it was fixed for `debugger` by an extension gate on that one rule. Rules 1, 5, 7, 9, 10, 11 have the identical exposure and no gate. The held-out run found it once because it sampled one Python repo at n=15.
2. **The lexical discount is applied to findings that are structurally impossible, not merely unverified.** `0.428` is presented as "this is 43% likely real." For line 2 it is 0% likely real, and the mechanism can never say so.
3. **The false positives outrank the true positive.** `eval()` prose scores `5 × 0.428 = 2.14` before blast radius; the real SQL injection scores `4 × 0.315 = 1.26`. Ordering is inverted by exactly the term that is supposed to fix ordering.

---

# Part 2 — What the field knows, and which parts apply

Every source below was fetched and read; URLs are the ones retrieved.

## 2.1 Why static analysers get switched off

**Google — "Lessons from Building Static Analysis Tools at Google"** (Sadowski, Aftandilian, Eagle, Miller-Cushon, Jaspan; CACM 61(4), April 2018). [cacm.acm.org](https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/)

The load-bearing contribution is a *definition*, not a threshold:

> "We consider an issue to be an **'effective false positive'** if developers did not take positive action after seeing the issue. If an analysis incorrectly reports an issue, but developers make the fix anyway to improve code readability or maintainability, that is not an effective false positive. If an analysis reports an actual fault, but the developer did not understand the fault and therefore took no action, that **is** an effective false positive."

And: *"Developers, not tool authors, will determine and act on a tool's perceived false-positive rate."*

The thresholds follow from that definition, and there are two, not one:

- **Code-review checks: "Produce less than 10% effective false positives."** Plus: understandable, actionable with fix guidance, and potentially significant.
- **Compiler checks: "produce no effective false positives"** — the analysis must never stop the build for correct code.

Tricorder operationalises the 10% with a feedback loop, not an audit: reviewers click "Please fix" or "Not useful"; the team tracks the ratio; **"If the ratio for an analyzer goes above 10%, the Tricorder team disables the analyzer until the author(s) improve it."** Scale as of Jan 2018: ~50,000 code-review changes/day, >5,000 "Please Fix"/day, ~250 "Not useful"/day.

The historical evidence for why a findings list does not work is in the same paper. The 2009 FindBugs company-wide Fixit: 9,473 warnings, 3,954 reviewed (42%), **640 fixed (16%)** despite 1,746 bug reports being filed. The earlier dashboard "saw little use because a bug dashboard was outside the developers' usual workflow."

**Facebook — "Scaling Static Analyses at Facebook"** (Distefano, Fähndrich, Logozzo, O'Hearn; CACM 62(8), August 2019). [cacm.acm.org](https://cacm.acm.org/research/scaling-static-analyses-at-facebook/)

The single most quoted number in industrial static analysis, and it is about *timing*, not accuracy:

> "The first deployment was batch rather than continuous… We assigned 20-30 issues to developers, and almost none of them were acted on. We had worked hard to get the false positive rate down to what we thought was less than 20%, and yet the fix rate — the proportion of reported issues that developers resolved — was near zero. Next, we switched Infer on at diff time. The response of engineers was just as stunning: **the fix rate rocketed to over 70%. The same program analysis, with same false positive rate, had much greater impact when deployed at diff time.**"

Two explanations offered by their own developers: **context switch** (the reviewer already has the code paged in) and **relevance** (the person who wrote the line is the person reading the report).

The paper also refuses to publish precision, on principle: *"the false positive rate is challenging to measure for a large, rapidly changing codebase: it would be extremely time consuming for humans to judge all reports as false or true as the code is changing… we don't make claims about their rates and pay more attention to the action rate and the (observed) missed bugs."* Zoncolan's action rate is >80% with ~11 observed missed bugs, and it accounts for 43.3% of severe security bugs found by any method at Facebook.

Note also that Facebook explicitly rejects Google's position on false negatives: *"false negatives matter to us"* — the tolerance is set per bug class and per audience, not globally.

**What applies to CodeGraph.**

- The 10% effective-FP ceiling is the right target *shape*: per-rule, measured by user action, with automatic disablement. CodeGraph's aggregate 87% is roughly at the line; the per-rule table is where the decision belongs.
- **The "effective" qualifier is the part CodeGraph is missing entirely.** `Untyped \`any\`` at severity 1 may be technically true 100% of the time and effectively false 100% of the time. Precision as currently defined (`PRECISION_PROTOCOL.md` §3 rule 1: "the finding claims presence, not importance") deliberately measures the wrong thing for this purpose — correctly, for its stated purpose, but it means the 87% figure cannot be compared to Google's 10% ceiling.
- **The diff-time result is the most transferable finding in this document, and it is a *workbench* feature, not a scanner feature.** CodeGraph already indexes git history and already has Timeline. "Findings introduced by this commit / this branch" is the CodeGraph-native expression of diff-time deployment, and Facebook's data says it is worth more than several points of precision.
- Facebook's refusal to claim a precision rate, while publishing an action rate, is a model CodeGraph could copy honestly: it already has dismissal state (`FindingStatus`, `finding.ts:75`) and verified fixes.

## 2.2 Techniques that raise precision, and what each costs

| Technique | What it buys | Cost | Applicable to CodeGraph now? |
|---|---|---|---|
| **Syntactic context** (comment/string/code) | Kills the "text describes the thing" class outright | Already paid for TS. A tree-sitter or lightweight lexer for Python/Go is days, not weeks | **Yes — the highest-value gap.** §1.6 shows the gate is a no-op outside TS, and `PRECISION_PROTOCOL.md` §6 found "mention vs. occurrence" was 11 of 14 FPs on the tuned corpus |
| **Name resolution** (does `eval` bind to global `eval`?) | Kills the "any `.query(` matches" class | Free for TS — `ts.Program` + `checker.getSymbolAtLocation` already exists in `packages/core-graph/src/ast-extractor.ts` per Phase 6.6 | **Yes**, for the JS/TS half |
| **Type information** | Kills `{ margin: any }`, resolves receivers | TS compiler API; the memory cost is already analysed in `DETECTION_ENGINE.md` §4.9 | Yes, bounded by the 512 MB ceiling |
| **Intraprocedural dataflow with sanitizers** | Kills "safe code flagged" — the fastest way to lose trust in a score | Weeks. CFG + def-use per function | Partially present (`dataflow.ts`), flow-insensitive, sinks only |
| **Interprocedural taint (bounded)** | Recall on real injection, not precision | Weeks. Function summaries, depth ≤3 | Designed (`DETECTION_ENGINE.md` §4.5), not built |
| **Path sensitivity / abstract interpretation** | Feasibility of the path reaching the sink | This is where cost explodes. Google, with Google's resources, declined: *"Analysis teams would have to develop techniques to dramatically reduce false-positive rates for many research analyzers"*, and the up-front infrastructure investment was judged prohibitive | **No.** Consistent with `DETECTION_ENGINE.md` §4.8 |

The asymmetry worth internalising: **the first three rows are cheap and kill whole FP classes; the last two are expensive and mostly buy recall.** CodeGraph's measured failures (§1.6, `PRECISION_PROTOCOL.md` §6-§8) are almost entirely in the first three rows.

## 2.3 Ranking and triage instead of pure detection

The SCA industry's convergence is that **an unreachable vulnerability is not a priority** — build a call graph from entry points and report only what is reachable. `DETECTION_ENGINE.md` §3.5 already records this and the vendor-claimed FP reductions; it is not re-litigated here.

What is worth adding for *reliability* specifically:

- **Ranking is the honest response to irreducible uncertainty.** If a rule is 70% precise and cannot be made better cheaply, the reliability move is not to hide it — it is to ensure it never outranks a 95% finding. CodeGraph already has the mechanism (`expectedHarm`); what it lacks is any evidence that the 70 and the 95 are the right numbers.
- **Historical fix-rate feedback is the within-repository signal `ADR-009` explicitly leaves open.** ADR-009 retires cross-project weight fitting but says: *"Per-file risk ranking is where history signals may earn their place… That is a within-repository question by construction, and it is validated per-repository against that repository's own history."* A per-repo, per-rule empirical precision — "on *this* repo, findings from this rule were dismissed 80% of the time" — is squarely inside that carve-out. See §4.
- **Actionability, not truth, is the user-facing quantity** (Google's effective-FP definition, §2.1). CodeGraph has an unusually strong actionability signal available that nobody else has: **whether a generated fix survived the repo's own test suite** (`packages/verify/`, `packages/remediate-engine/`). A rule whose fixes verify is a rule whose findings were real and actionable. That is ground truth, produced by the product's own headline feature, and it is currently not fed back anywhere.

## 2.4 LLM-assisted verification of findings — and the trap

**Semgrep** publishes its numbers with methodology, which makes them usable. [docs.semgrep.dev/semgrep-multimodal/metrics](https://docs.semgrep.dev/semgrep-multimodal/metrics.md), as of 2025-08-21:

| Measure | Value |
|---|---|
| Customers in dataset | 3,500+ |
| Findings analysed | 6,500,000+ |
| Average reduction in findings (noise filtered) | **60%** |
| Human-agree rate | **96%** |
| Internal benchmark, findings analysed | 2,000+ |
| **False-positive confidence rate** | **96%** |
| Remediation-guidance confidence rate | 80% |

The footnote is the most important line on the page and is easy to miss:

> "False positive confidence rate measures how often Multimodal is correct **when it identifies a false positive**. **A high confidence rate means users can trust when Multimodal identifies a false positive — it does not mean that Multimodal catches all false positives.**"

That is precision-of-the-suppressor, not recall-of-the-suppressor. A suppressor can be 96% precise and catch 10% of the noise.

**ZeroFalse** (Iranmanesh et al., 2026, [arxiv.org/html/2510.02534](https://arxiv.org/html/2510.02534)) is the most methodologically useful public result, and its useful part is a failure. It enriches CodeQL SARIF alerts with dataflow traces and CWE-specific rubrics, then has an LLM adjudicate, with deterministic prompts (temperature 0), schema-constrained JSON output, and a full audit trail. On the OWASP Java Benchmark it reports F1 0.912 (grok-4) and 0.910 (gemini-2.5-pro). Then, on **OpenVuln** — their curated dataset of real CodeQL alerts from seven real Java projects, labelled by comparing against the actual security patch —

> "some large-scale models, such as gemini-2.5-pro, **collapsed under real-world noise (F1=0.372)**."

Same framework, same prompts, same model: 0.910 on the synthetic benchmark, 0.372 on real code. **This is the single strongest published warning against trusting benchmark numbers for a triage layer**, and it is the reason a CodeGraph LLM triage layer would have to be validated on CodeGraph's own labelled corpus, not on a public suite.

**The trap, stated precisely.** An LLM shown a finding and asked "is this real?" is being asked to agree with a claim already framed as true. That is not verification; it is a second opinion from a model with a documented agreement bias, correlated with the first opinion because both are reading the same tokens. Two consequences for CodeGraph:

1. **An LLM verdict is evidence only if it is falsifiable and independently grounded.** ZeroFalse's design is instructive because the LLM is not asked "is this a bug?" but "given this *specific dataflow trace* and this *CWE rubric of non-sanitizers*, does the trace satisfy the rubric?" The evidence is the trace; the LLM is a rubric evaluator. An LLM adjudicating a bare line-regex hit has nothing to evaluate.
2. **`ADR-007`/`DETECTION_ENGINE.md` §4.8 already bans an LLM in the detection path** ("may *suppress* or *explain* a finding… but never *create* one"). Reliability adds a reason beyond reproducibility: an LLM suppressor that is 96% precise at suppression, deployed against a detector whose own precision is unmeasured per-rule, produces a system whose end-to-end precision nobody can compute. **Measure the detector first; only a measured detector can have a measured suppressor.**

There is also a hard product constraint: **no API key** is a load-bearing promise (`IDENTITY.md` §2). Any LLM triage must be opt-in, off by default, and must not change the default-configuration numbers CodeGraph publishes.

## 2.5 Calibration: how to make the printed number mean something

The distinction that matters, and that CodeGraph currently conflates:

- **Discrimination** — do higher-confidence findings tend to be more often true? (Ranking quality. Partly what `expectedHarm` is for.)
- **Calibration** — of all findings printed at confidence 0.8, are ~80% true? (Whether the *number* is honest.)

A model can discriminate perfectly and be badly calibrated, and vice versa. CodeGraph prints a calibrated-looking quantity ("confidence 78%", `AgentSwarm.tsx:160`) and has evidence for neither property.

**Brier score** — Brier, "Verification of Forecasts Expressed in Terms of Probability," *Monthly Weather Review* 78(1):1-3, 1950, doi:10.1175/1520-0493(1950)078<0001:VOFEIT>2.0.CO;2 ([journals.ametsoc.org](https://journals.ametsoc.org/view/journals/mwre/78/1/1520-0493_1950_078_0001_vofeit_2_0_co_2.xml)). The mean squared error between a forecast probability and the binary outcome: `BS = (1/N) Σ (pᵢ − oᵢ)²`, lower is better. It is a *proper* scoring rule — it is minimised by reporting your true belief, so a rule author cannot game it by hedging everything to 0.5 or by inflating everything to 0.95. This is exactly the property needed when the numbers are hand-assigned by the person whose rule is being judged.

**Reliability diagram** — bin findings by predicted confidence, plot observed frequency-true against predicted confidence per bin. Perfect calibration is the diagonal. Above the diagonal = underconfident; below = overconfident. The decomposition into calibration and refinement components is standard and the practical recipe is well documented in Guo, Pleiss, Sun & Weinberger, "On Calibration of Modern Neural Networks," ICML 2017, [arXiv:1706.04599](https://arxiv.org/abs/1706.04599) — which also supplies the cheapest fix: *"temperature scaling — a single-parameter variant of Platt Scaling — is surprisingly effective at calibrating predictions."* One parameter, fitted on held-out labelled data, monotone (so it **cannot change any ranking**). For CodeGraph the analogous single-parameter move is a per-rule shift toward its measured precision.

**Precision@k.** Because a user reads the top of a list, not the list, precision@10 and precision@25 predict the trust experience better than aggregate precision. It is also the metric that would have caught §1.6's inversion, where two false positives outrank a true injection.

**Inter-rater agreement.** `PRECISION_PROTOCOL.md` §5 names its own biggest weakness: "The labels are the implementer's… Someone who did not write the rules should re-label the same sample." The standard instrument is Cohen's κ, with the Landis–Koch bands (κ > 0.6 substantial, > 0.8 almost perfect) as the conventional reading. Cheap version that fits CodeGraph's reality as a solo/small project: **re-label a 20-finding stratified subsample blind, at a delay, and report κ against the original labels.** Self-agreement over time is weaker than a second rater but is not nothing, and it is honest to label it as such.

**The methodological point that makes calibration cheap for CodeGraph:** calibration needs *fewer* labels than precision estimation, because it pools across rules. 200 labels spread over five confidence bins gives a usable reliability diagram; 200 labels split per-rule gives nothing per rule. So the same labelling budget buys a calibration claim that the current protocol cannot buy.

## 2.6 Regression-testing the analyser itself

The analyser is software with no tests on its most important property. What could CodeGraph actually run?

| Corpus | What it is | Runnable here? |
|---|---|---|
| **OWASP Benchmark** ([owasp.org](https://owasp.org/www-project-benchmark/)) | Java v1.2: 2,740 executable test cases across 11 CWEs, each labelled true-vuln or false-positive in `expectedresults-1.2.csv`. Python v0.1: 1,230 cases across 14 CWEs, v1.0 targeted early 2026. Scored by Youden index (`(sensitivity + specificity) − 1`) | **Java: no** (no Java extractor). **Python: partially** — but Python is `lexical` tier with no context gate, so the result would measure the tier, not the rules. Worth running *once* as a documented floor. Note OWASP's own warning: *"most real-world applications will be considerably harder to successfully analyze than the OWASP Benchmark Test Suite."* |
| **Juliet** (NIST SARD, [samate.nist.gov/SARD/test-suites](https://samate.nist.gov/SARD/test-suites)) | C/C++ 1.3: 64,099 cases / 118 CWEs. Java 1.3: 28,881. C# 1.3: 28,942. PHP suites: 42,212 and 248,592 | **No.** Verified from the SARD suite index: **there is no JavaScript or TypeScript Juliet suite.** The entire seeded-bug tradition skips CodeGraph's primary language. |
| **Defects4J** ([github.com/rjust/defects4j](https://github.com/rjust/defects4j)) | 854 reproducible real Java bugs across 17 projects, each minimised, each with a triggering test. MIT | **No** — Java. Its *methodology* is the transferable part: a bug is admitted only if a test fails before the fix and passes after. |
| **SecBench.js** ([github.com/cristianstaicu/SecBench.js](https://github.com/cristianstaicu/SecBench.js)) | **600 real, executable server-side JavaScript vulnerabilities** curated from Snyk / GitHub Advisories / Huntr: prototype pollution 192, path traversal 169, command injection 101, ReDoS 98, arbitrary code injection 40. Each entry is a **jest test that exploits the vulnerability**, plus `package.json` metadata carrying CVE id, `fixedVersion`, `fixCommit`, and a `sinkLocation` (file:line:col) | **Yes. This is the one.** It is JavaScript, it is real code rather than synthetic, it is pinned to versions, it ships exploit tests, and — the part that matters most — **it provides `sinkLocation` ground truth at line granularity**, which is exactly the label CodeGraph's `Finding.range` would be scored against. |
| **Own snapshot corpus** | The five repos already pinned in `PRECISION_PROTOCOL.md` | **Yes, and this should exist first.** A committed JSON scorecard per pinned commit turns any change in the finding set into a reviewable PR diff — the affordance `DETECTION_ENGINE.md` Part 6 describes and nothing implements. |
| **Mutation testing of rules** | Mutate the rule, assert a fixture test fails | **Yes, and it is already in this project's vocabulary.** `PRECISION_PROTOCOL.md` §8 records mutation testing catching that four `debugger` tests were each satisfied by a *different* mechanism, so none pinned the statement form; `packages/analysis/tests/analysis-tier.test.ts:44-53` records mutation testing catching an assertion that could not fail (`confidence > 0` passing with the factor set to zero). This technique has already found two real defects here. |

**SecBench.js deserves a paragraph on why it is unusually well matched.** CodeGraph's headline differentiator is *verified remediation — a fix that must survive the project's own test suite* (`IDENTITY.md` §2, item 4), implemented in `packages/verify/` and `packages/sandbox/`. SecBench.js entries **are** projects with test suites where the test is an exploit. Running one is: install the pinned vulnerable package, index it, check whether CodeGraph reported a finding at the `sinkLocation`, and — if a fixer applies — check whether the exploit test now fails to exploit. That is a recall measurement *and* a fix-verification measurement, on real code, in the primary language, reusing infrastructure that already exists. Nothing else in the benchmark landscape offers that.

The caution, recorded rather than glossed: 600 exploits × npm install is minutes-to-hours and network-dependent, three of the five classes (prototype pollution, path traversal, command injection) require analysis CodeGraph does not have, and the expected first-run recall is low. **A low number that is real is the point** — recall is currently unmeasured and unmeasurable, and `PRECISION_PROTOCOL.md` §1 says so.

---

# Part 3 — A staged plan

Ordered by (impact ÷ effort). Each stage names files and a measurement. **P** = raises precision, **R** = raises recall, **C** = improves calibration, **X** = improves presentation/trust only.

### Stage 0 — Stop the gate being a no-op outside TypeScript · **P** · ~1 day · ✅ **SHIPPED 2026-08-02**

**The bug found by §1.6, and the highest ratio in this document.** `detect.ts:365` skipped the context check entirely when `spans` was empty, so `context: ["comment"]` and `context: ["code"]` were unenforced on every non-TS file. A `# TODO` inside a Python string was reported as a marker; prose mentioning `eval()` was a severity-5 security finding.

- **Shipped as:** `lexicalSpans()` + `spansFor()` in `packages/core-graph/src/source-context.ts`; `detect.ts:348` now calls `spansFor`. Comment and string grammars for Python, Go, Rust, Java, Kotlin, Scala, Swift, C#, C, C++, Ruby, Shell and PHP — the TS family keeps the parser.
- **Why lex at all, when the module's own comment refused to.** That refusal is correct about JavaScript and only about JavaScript: regex-versus-division, template substitution and `rescanTemplateToken` are the hazards it names, and none of them exist in the languages above. Declining to lex was not neutral — it took 100% of the risk in the other direction. A language with no rules still returns `[]` and still fails open, so nothing is silently swallowed.
- **Measured on real corpora, not fixtures.** `psf/requests` (37 files) and `pallets/flask`: **unchanged**, 88 → 88 findings — no false negatives introduced. `psf/black`: **279 → 275**, and all four suppressed findings are unambiguous false positives:
  - `src/blib2to3/pgen2/literals.py:4` — `Use of eval()`, **severity 5**, fired on the module docstring *"Safely evaluate Python string literals without using eval()."* The one file in the repository whose stated purpose is not using eval.
  - `tests/test_black.py:1898, 2185, 2188` — `Suppressed checker`, fired on `# type: ignore` inside Python **string literals** in test fixtures.
- **Also covered:** 11 cases in `packages/core-graph/tests/source-context.test.ts`, each asserting the failure direction the module warned about — an apostrophe in a comment (`# don't do this`) must not swallow the rest of the file, an unterminated single-quoted string must not run past its line, an escape must not close a string early, and a triple-quoted docstring must be one span rather than three.
- **Still open from this stage:** the `precision-heldout` re-run against `pallets/flask@6a2f545`. Flask's finding count did not move, so the 73% figure will not change without re-labelling; that belongs to Stage 3.

### Stage 1 — A committed snapshot scorecard, in CI · **X→P** · ~2-3 days

Nothing today can tell you that a rule change made things worse. This is the prerequisite for every other stage, so it is done inline and first.

- **Touches:** new `scripts/scorecard.mts` (sibling to `scripts/bench.mts`, same pinned-clone pattern); new `docs/design/scorecard/<repo>@<sha>.json`; `package.json` script.
- **Change:** for each of the five pinned corpora, emit `{rule, file, line, severity, confidence}` for every finding, sorted deterministically. Commit it. A rule change now shows up as a reviewable diff in a PR.
- **Measured by:** the diff itself — findings added, findings removed, per rule. Add a CI check that fails on an *uncommitted* scorecard change, in the spirit of `scripts/check_boundaries.py`.
- **Note:** this is snapshot-of-output, not ground truth. It catches regressions, not wrongness. That is the cheap 80%.

### Stage 2 — Make `ConfidenceBasis` real end to end · **X, prerequisite for C** · ~3-4 days

Today an AST finding, a taint-verified finding and a regex hit are all persisted as `syntactic`/`lexical` (`runs.ts:152-153`). The type that already exists (`finding.ts:48-53`) is the honest axis and it is being discarded at the boundary.

- **Touches:** `packages/analysis-model/src/models.ts` (add `confidenceBasis` and `analysisTier` to `Issue`); `packages/detect-engine/src/detect.ts` (stamp `syntactic` for regex, `structural` for ESLint AST, `dataflow_verified` only when `classifyTaint` returned `tainted`); `packages/persistence/src/runs.ts:132-159`; `packages/analysis-model/src/sarif.ts` (export it in `properties`); the finding UI.
- **Change:** basis is **derived from how the finding was produced**, never assignable by a rule author. Group the UI by basis, not only severity.
- **Measured by:** a test asserting the basis distribution over a fixture repo, and that no code path can set `dataflow_verified` without a concrete trace.
- **Why it precedes calibration:** calibration is per-*population*. Basis is the population variable that is actually causal; rule id alone is too sparse.

### Stage 3 — Calibrate the printed number · **C** · ~1 week (mostly labelling)

Make the number on screen mean what it says, or stop printing it as a percentage.

- **Touches:** extend `PRECISION_PROTOCOL.md` with a calibration section; new `docs/design/calibration-<date>.json`; a scoring script; `packages/detect-engine/src/detect.ts` for the per-rule adjustment; `apps/web/src/components/AgentSwarm.tsx:160` for presentation.
- **Change:**
  1. Sample **200** findings by the existing fixed stride across all five pinned corpora, **stratified by confidence bin** (0–0.2, …, 0.8–1.0) so every bin has mass — the current stride under-samples low-confidence findings.
  2. Label with the existing §3 rules. Report a **reliability diagram** and a **Brier score**, plus precision@10 and precision@25 per corpus.
  3. Adjust each rule's constant toward its measured precision. Monotone, per-rule — **this is not a fitted model and not a cross-project weight** (see §4).
  4. Re-score; report the Brier improvement.
  5. Blind re-label 20 stratified findings after ≥1 week; report Cohen's κ against the originals and label it self-agreement, not independent adjudication.
- **Measured by:** Brier score before/after; every reliability bin within its Wilson interval of the diagonal; κ reported whatever it is.
- **Honest cost:** 200 findings at ~2 minutes each is ~7 hours of reading, and it is the only part of this document that cannot be automated. **If this stage is not done, Stage 5 should not be attempted**, because an unmeasured detector cannot have a measured suppressor.
- **Escape hatch if the labelling budget does not exist:** stop rendering `confidence` as a percentage and render the basis ladder instead. A four-rung qualitative scale that is true beats a two-decimal number that is not.

### Stage 4 — Recall, measured for the first time, via SecBench.js · **R** · ~1 week

- **Touches:** new `scripts/secbench.mts`; new `docs/design/recall-secbench.json`; reuses `packages/sandbox/` and `packages/verify/`.
- **Change:** clone SecBench.js pinned; for a **stratified subset (start at 50, one class at a time)**, install the vulnerable package version, index it, and check whether any finding lands within ±2 lines of the entry's `sinkLocation`. Record hit/miss per CWE class.
- **Measured by:** recall per class, published with the denominator. Where a fixer exists, additionally record whether the exploit test stops exploiting after the fix — that is `IDENTITY.md` §2's verified fix, benchmarked.
- **Honest cost:** network-heavy, slow, and the first number will be low — three of the five classes need analysis CodeGraph does not have. **Publishing a low measured recall is the deliverable.** It replaces "recall is out of scope" with a number and a denominator.
- **Do not** wire this into per-PR CI. Weekly or pre-release, per `DETECTION_ENGINE.md` Part 6's tiering.

### Stage 5 — Diff-scoped findings ("what did this commit introduce?") · **P (effective), X** · ~1-2 weeks

The Infer result (§2.1): identical analysis, identical FP rate, ~0% → >70% fix rate purely from moving to diff time. This is the largest published trust improvement available that requires **no detection work at all**.

- **Touches:** `packages/vcs/`; `packages/core-domain/src/fingerprint.ts` (already exists, already fingerprints location-independently); the Timeline view; the repo detail page.
- **Change:** a default filter for "findings whose fingerprint is absent from the parent commit's run." Infer's own new-issue definition is fingerprint-based and deliberately survives file moves and line shifts — CodeGraph already has that primitive.
- **Measured by:** the count reduction (findings-in-diff ÷ findings-in-repo) on the pinned corpora; and, once dismissal telemetry exists, dismissal rate for diff-scoped vs. whole-repo findings.
- **Why it belongs to the workbench and not the scanner:** it is the Timeline lens applied to findings. It strengthens `IDENTITY.md` §1's loop rather than competing on a findings leaderboard.

### Stage 6 — Replace the additive critic with corroboration that means something · **C** · ~2-3 days

`orchestrator.ts:93`'s `confidence + 0.15 × others.length` adds on a probability scale and treats non-independent agreements as independent (§1.3).

- **Touches:** `apps/web/src/lib/agents/orchestrator.ts:73-115`; `apps/web/src/lib/agents/specialists.ts`.
- **Change:** (a) combine in odds space and cap, so the operation is at least type-correct for a probability; (b) **corroborate only across distinct `confidenceBasis` values** (Stage 2's output) — two specialists re-reading the same regex hit are one piece of evidence, an AST finding plus a dataflow trace at the same locus are two.
- **Measured by:** existing `orchestrator.test.ts` boundary tests, extended with a same-basis case that must **not** corroborate; and the Stage 3 reliability diagram restricted to corroborated findings, which is where the current scheme should be most overconfident.

### Stage 7 (conditional) — Optional, opt-in LLM adjudication of *traced* findings only · **P** · ~2 weeks

Only after Stages 2, 3 and 4. Gated behind an explicit user-supplied key, off by default, and excluded from any published number.

- **Change:** adjudicate only findings that carry a concrete dataflow trace, using ZeroFalse's shape — evidence-gated prompt, deterministic decoding, schema-constrained output, full audit trail. The LLM evaluates a rubric against a trace; it never adjudicates a bare regex hit and never creates a finding.
- **Measured by:** the Stage 3 labelled corpus, reporting **both** directions — suppressor precision *and* suppressor recall — because Semgrep's own footnote shows how easily those are conflated. Report agreement with the human labels, not agreement with the rule.
- **Refuse if:** it changes a default-configuration published number, or the measurement is done on a public benchmark rather than CodeGraph's own corpus. ZeroFalse's 0.910 → 0.372 collapse is the reason.

### Explicitly not proposed

- Path sensitivity / symbolic execution (§2.2; consistent with `DETECTION_ENGINE.md` §4.8).
- Running OWASP Benchmark or Juliet as a gate — no JS/TS suite exists in Juliet, and OWASP disclaims its own realism.
- Any cross-project learned model (`ADR-009`).
- Any letter grade or pass/fail gate on precision (`IDENTITY.md` §4.2).

---

# Part 4 — Conflicts with binding documents

Nothing above is slipped in. Each item that touches a binding decision is argued here.

### `ADR-009` — cross-project calibration was rejected

ADR-009 rejects **universal learned score weights, cross-project ROC AUC as a target, and a retained corpus of other people's repositories.** Its stated mechanism is base-rate non-transfer: a model cannot know a held-out repository's base rate.

| Stage | Conflict? | Argument |
|---|---|---|
| **Stage 3 (calibrate confidence)** | **Borderline. Argued explicitly.** | It fits per-rule constants using labels drawn from five external repositories, which is the shape ADR-009 warns about. Three reasons it is materially different, and one guard. **(1) Different quantity.** ADR-009 rejects predicting *which files are defective* — a repository-level base rate. `confidence` predicts *whether a rule that already matched is describing something real*, which is a property of the rule's mechanism, not of the repository's defect density. The two failure modes ADR-009 measured (socket.io 78% actual vs max 0.269 predicted; eslint 11% actual vs 0.515 median) are base-rate errors and have no analogue here. **(2) No model.** One number per rule, adjusted monotonically toward an observed frequency. No features, no fitting pipeline, no `@codegraph/calibrate` resurrection. **(3) It is already happening, unmeasured.** `0.7` for SQL concatenation is a cross-project constant, typed by hand, applied to every user's repository. Replacing a guessed cross-project constant with a measured one is a strict improvement in honesty; the only alternative is to keep the guess. **Guard, and this is the load-bearing part: the per-rule reliability must be reported per corpus, not pooled.** If precision for a rule varies widely across the five corpora, that rule's constant is **not** adjusted and the variance is published instead — because that is base-rate non-transfer showing up, and ADR-009's reasoning applies directly. **No corpus of other people's repositories is retained**; the pinned corpora are clone-on-demand at a fixed sha, as `PRECISION_PROTOCOL.md` §2 and `scripts/bench.mts` already do. |
| **Stage 4 (SecBench.js recall)** | **No.** | Measurement, not weight fitting. Nothing learned is shipped. |
| **Stage 5 (diff-scoped findings)** | **No — actively aligned.** | Within-repository by construction. ADR-009: *"Per-file risk ranking is where history signals may earn their place… validated per-repository against that repository's own history."* |
| **Per-repo learned fix-rate ranking** (§2.3, deliberately **not** staged) | **No, and it is ADR-009's own reversal condition** | ADR-009: *"A within-repository validation showing the history-derived ranking beats file size on the indexed repository's own history."* Worth building later; out of scope here because it needs dismissal telemetry that does not exist. |

### `IDENTITY.md`

| Concern | Assessment |
|---|---|
| **§4.6 — detection serves the workbench; it is not the product** | The genuine tension in this document. Mitigations: Stage 5 is a Timeline feature; Stage 4's payoff is measured through verified fixes (§2 item 4); Stage 2's payoff is the finding-detail UI grouping by evidence quality. **The one hard line: no stage adds a "findings leaderboard" or benchmark badge to the UI or the README.** The scorecards live in `docs/design/`, for contributors. |
| **§4.2 — the Health Score is the number, no grades or gates** | Stage 3 changes inputs to `expectedHarm` and will move every repository's Health Score. That is the same category of deliberate move `score.ts:100-104` already records for `k = 0.06` and `PLAN.md` §5.1's pillar split, and it must be recorded the same way rather than compensated for. **No precision figure becomes a user-visible grade, badge, or gate.** |
| **§4.4 — never position reactively** | Google's 10% and Semgrep's 96% are used as *methodology* (what to measure, how to define it), never as targets to beat. No exit criterion in Part 3 is expressed as a competitor's published figure — that is precisely the mistake ADR-009 was written about. |
| **§3 — technique vs. identity** | Brier scores, reliability diagrams, precision@k, Cohen's κ, temperature scaling, snapshot testing, mutation testing are field-standard and predate every product named here. SecBench.js, Defects4J, Juliet and OWASP Benchmark are public research artifacts, used as corpora, not as models to imitate. |
| **§2 — one container, one SQLite file, no API key** | Stage 7 is the only stage that could threaten this, and it is opt-in, off by default, and excluded from published numbers. Stages 0-6 add no runtime dependency; the scorecard and recall harnesses are `scripts/`, not product. |

### One thing this document refuses to recommend

Suppressing findings in `*.test.*` and `examples/` to raise the precision number. `PRECISION_PROTOCOL.md` §7 already declined it, with the right reason: *"A real credential committed to a test file is precisely the case worth catching, and path-based suppression would silence it."* It would raise the headline by several points and is a recall decision disguised as a precision fix. The correct move is the reachability weighting `DETECTION_ENGINE.md` §4.7 already designs — rank it down, keep it visible.

---

## Summary table — what each stage actually buys

| Stage | Precision | Recall | Calibration | Presentation | Effort |
|---|---|---|---|---|---|
| 0 · non-TS context gate | **✓✓** | — | ✓ (removes impossible findings from the mass) | — | 1 day |
| 1 · snapshot scorecard | (guards) | (guards) | — | — | 2-3 days |
| 2 · real `confidenceBasis` | — | — | prerequisite | **✓✓** | 3-4 days |
| 3 · calibration | ✓ | — | **✓✓✓** | ✓ | 1 week (mostly labelling) |
| 4 · SecBench.js recall | — | **measures it** | — | — | 1 week |
| 5 · diff-scoped findings | **✓✓ (effective)** | — | — | **✓✓** | 1-2 weeks |
| 6 · corroboration in odds space | ✓ | — | **✓✓** | — | 2-3 days |
| 7 · opt-in LLM adjudication | ✓✓ | — | ✓ | — | 2 weeks, conditional |

**If only one thing is done: Stage 0.** It is a day's work, it fixes a live correctness hole verified in §1.6, and it is the same class of failure the held-out run caught once and the codebase then fixed for exactly one rule.

**If only one thing is done for calibration: stop printing `confidence` as a percentage until Stage 3 exists.** A number that looks like a probability and is not one is the only finding in this document that actively misleads a user.

---

## Sources

All fetched and read on 2026-08-02.

**Industrial experience**
- Sadowski, Aftandilian, Eagle, Miller-Cushon, Jaspan. *Lessons from Building Static Analysis Tools at Google.* CACM 61(4), April 2018. https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
- Sadowski, van Gogh, Jaspan, Söderberg, Winter. *Tricorder: Building a Program Analysis Ecosystem.* ICSE 2015. https://research.google/pubs/tricorder-building-a-program-analysis-ecosystem/ (abstract page; the operational 10% "Not useful" threshold and Tricorder scale figures are quoted from the CACM 2018 paper above, which reports them directly)
- Distefano, Fähndrich, Logozzo, O'Hearn. *Scaling Static Analyses at Facebook.* CACM 62(8), August 2019. https://cacm.acm.org/research/scaling-static-analyses-at-facebook/

**LLM-assisted triage**
- Semgrep. *Semgrep Multimodal metrics and methodology.* https://docs.semgrep.dev/semgrep-multimodal/metrics.md
- Semgrep. *Semgrep Multimodal overview.* https://docs.semgrep.dev/semgrep-multimodal/overview
- Iranmanesh, Moradi Sabet, Marefat, Javidi Ghasr, Wilson, Sharafaldin, Tayebi. *ZeroFalse: Improving Precision in Static Analysis with LLMs.* 2026. https://arxiv.org/html/2510.02534

**Calibration**
- Brier. *Verification of Forecasts Expressed in Terms of Probability.* Monthly Weather Review 78(1):1-3, 1950. doi:10.1175/1520-0493(1950)078<0001:VOFEIT>2.0.CO;2 https://journals.ametsoc.org/view/journals/mwre/78/1/1520-0493_1950_078_0001_vofeit_2_0_co_2.xml
- Guo, Pleiss, Sun, Weinberger. *On Calibration of Modern Neural Networks.* ICML 2017. https://arxiv.org/abs/1706.04599

**Benchmarks and corpora**
- OWASP Benchmark Project. https://owasp.org/www-project-benchmark/
- NIST SARD test-suite index (Juliet C/C++ 1.3, Java 1.3, C# 1.3; language coverage). https://samate.nist.gov/SARD/test-suites and https://samate.nist.gov/SARD/test-suites/112
- Just, Jalali, Ernst. *Defects4J.* https://github.com/rjust/defects4j
- Bhuiyan, Parthasarathy, Staicu et al. *SecBench.js: An Executable Security Benchmark Suite for Server-Side JavaScript.* https://github.com/cristianstaicu/SecBench.js

**Internal (paths as of 2026-08-02)**
`packages/detect-engine/src/detect.ts` · `packages/detect-engine/src/eslintSecurity.ts` · `packages/core-graph/src/source-context.ts` · `packages/core-graph/src/dataflow.ts` · `packages/score-engine/src/score.ts` · `packages/core-domain/src/finding.ts` · `packages/analysis-model/src/models.ts` · `packages/persistence/src/runs.ts` · `packages/analysis/src/indexer.ts` · `apps/web/src/lib/agents/orchestrator.ts` · `apps/web/src/lib/agents/specialists.ts` · `apps/web/src/components/AgentSwarm.tsx` · `docs/design/PRECISION_PROTOCOL.md` + `precision-{sample,sample-2,sample-3,heldout}.json` · `docs/design/ADR-009-score-calibration.md` · `docs/design/DETECTION_ENGINE.md` · `docs/design/IDENTITY.md`
