# CodeGraph — Identity

| | |
|---|---|
| **Status** | **Binding.** Design docs, code, UI copy, and marketing must conform. |
| **Date** | 2026-07-29 |
| **Owner** | Project owner (Koushik) — only he changes this document |
| **Applies to** | Everyone contributing, human or AI |

---

## 0. Why this exists

While researching how established analysis engines work, the v2 design drifted toward
importing *their* identity along with their techniques — another product's rule syntax, another
product's letter grades, another product's output model as our internal one, and a positioning
statement that defined CodeGraph by the gaps its competitors left.

That is how a tool with its own idea becomes a worse copy of four other tools.

This document draws the line. It is short on purpose, and it is meant to settle arguments
rather than start them.

---

## 1. What CodeGraph is

> **CodeGraph makes a codebase visible, then judges it, then fixes it — in one place, with no
> API key and no service to sign up for.**

The graph is not plumbing behind a findings list. **The graph is the product.** You point
CodeGraph at a repository and you *see* it: symbols, calls, dependencies, cycles, structure.
Everything else is a lens on that same graph — the Health Score summarises it, Code Intelligence
queries it, the swarm reasons over it, the Editor lets you act on it, and Timeline shows how it
moved.

Scanners emit lists. CodeGraph gives you a place to stand.

**The loop, which is the whole thesis:**

```
    see ──▶ understand ──▶ judge ──▶ fix ──▶ commit
     │                                          │
     └──────────────  Timeline  ◀───────────────┘
```

No other tool closes that loop. Most do one segment of it and hand you off.

### 1.1 Category

CodeGraph is a **codebase workbench**, not a scanner, not a code-search engine, not a linter.

*This term is provisional and belongs to the project owner.* What is not provisional is the
refusal to be filed under someone else's category — "a self-hosted SAST tool," "an open-source
Sonar," "CodeQL without the licence" are all wrong, and each one gives away the argument before
it starts.

---

## 2. What is ours

Five things. Everything distinctive about CodeGraph is one of these or a combination of them.

| # | Ours | Why it's ours |
|---|---|---|
| **1** | **The visible graph** — architecture flowchart, circle-pack, force-directed network, all interactive | Nobody else treats the program graph as the primary interface. Competitors expose graphs as query results, not as a place to look. |
| **2** | **The Health Score** — one explainable 0–100 number, weighted by blast radius, with its own coverage disclosed | A single number you can argue with, derived from graph structure. Not a grade handed down; a claim with its reasoning attached. |
| **3** | **The deterministic swarm** — specialists → critic → judge | Same repo, same answer, every time, with no model and no key. The critic/judge stage is a genuinely distinct idea: findings that corroborate each other earn confidence. |
| **4** | **Verified remediation** — a fix that must survive the project's own test suite | The strongest thing CodeGraph has, and as of the 2026-07 survey, **no other tool in this category does it.** Others suggest fixes. CodeGraph proves them. |
| **5** | **The closed loop in one app** — see, judge, fix, edit, commit, then watch it change over time | Each piece exists elsewhere. The loop does not. |

And the constraint that makes all five credible: **one container, one SQLite file, no API key,
MIT.** That is not modesty about scale. It is the product.

---

## 3. Technique vs. identity — the test

The distinction that makes this document usable rather than paralysing.

> **Ask: would a competent engineer reading this call it *"how static analysis works"* or
> *"how &lt;Product&gt; works"*?**
>
> The first is **technique** — public knowledge, use it freely, cite it if you like.
> The second is **identity** — someone else's. Don't take it.

**Technique. Use without hesitation.** Abstract syntax trees. Control-flow graphs. Def-use
chains and SSA. Taint propagation, including the source / propagator / sanitizer / sink
decomposition — that vocabulary is decades old and belongs to the field, not to any vendor.
Call graphs. Reachability. Strongly-connected components. Cyclomatic and cognitive complexity.
Content-addressed caching. Precision, recall, F1. Worklist algorithms. Fingerprinting.

Refusing these on identity grounds would be refusing arithmetic. They are how the work is done.

**Identity. Do not take.** A product's rule *syntax*. Its metric *names* and grading *scales*.
Its category *labels*. Its signature UI patterns. Its internal data model as our internal data
model. Its positioning.

**The asymmetry to remember:** implementing taint analysis the way the literature describes is
engineering. Naming our findings the way another product names its findings is imitation. The
technique is invisible to users; the vocabulary is the entire experience.

---

## 4. Specific prohibitions

Each one is a decision that was actually proposed and is now closed.

### 4.1 No borrowed rule syntax

Rules are expressed against **CodeGraph's own graph**, in CodeGraph's own vocabulary. We do not
adopt another tool's pattern language, metavariable convention, or query DSL — not even as
"inspiration," because a contributor who recognises the syntax will correctly conclude they are
using a lesser version of the thing they already know.

*Allowed:* reading how others solved a problem, then solving it our way.
*Not allowed:* a rule file that a user of another tool would recognise as that tool's format.

### 4.2 The Health Score is the number. No letter grades.

No A–E scale, no "quality gate," no pass/fail badge borrowed from another dashboard. The Health
Score is CodeGraph's metric and it stands alone.

Remediation-effort estimates may exist as a **secondary detail** — a hover, a tooltip, a column —
because effort is genuinely useful information. They never become the headline, never get a
letter, and never replace the score.

### 4.3 Interchange formats are exports, never the internal model

CodeGraph's `Finding` type is CodeGraph's. It carries what our product needs: evidence,
confidence basis, blast radius, analysis tier, graph provenance.

Standard interchange formats are supported at the **boundary**, as an export adapter, for CI
integration and interoperability. They are a serialiser. If our internal model is ever shaped by
what an external format can express, we have quietly become a commodity scanner with extra steps.

### 4.4 Never position reactively

**Banned framings**, all of which concede the frame:

- "X, but self-hosted"
- "open-source Y"
- "the gap that Z leaves empty"
- "we don't compete with W on ..." *(said before saying what we do)*
- any sentence that names a competitor before naming CodeGraph

**Do instead:** state what CodeGraph is, on its own terms, first and completely. If a comparison
is genuinely useful to a reader, it comes afterward, as a footnote, and it is honest in both
directions — including where we lose.

> ✗ *"CodeGraph won't out-detect CodeQL; its position is the intersection those tools leave empty."*
> ✓ *"CodeGraph shows you your codebase, scores its health, and proves its fixes by running your tests. One container, no API key."*

The first sentence is defensible and true. It is also an apology. Lead with the second.

### 4.5 No feature named after another product's feature

If a capability needs a name, name it from CodeGraph's own vocabulary (§5). Descriptive generic
names are fine. Another product's proper noun is not.

### 4.6 Detection serves the workbench; it is not the product

Detection quality matters — a workbench with a weak detector is a weak workbench, and the
current detector genuinely needs the upgrade described in `DETECTION_ENGINE.md`. But when
detection work starts driving the roadmap, the UI, or the pitch, CodeGraph is turning into a
scanner. The graph, the score, and the verified fix stay at the centre.

---

## 5. Vocabulary

| Ours — use these | Neutral — free to use | Theirs — don't adopt |
|---|---|---|
| **Health Score** | AST, CST, CFG, PDG, def-use | Another tool's query-language name |
| **blast radius** | taint, source, sink, sanitizer, propagator | `$X`-style metavariable pattern syntax |
| **the swarm** (specialists · critic · judge) | call graph, reachability, fan-in/fan-out | A–E maintainability ratings |
| **Code Intelligence** | cyclomatic / cognitive complexity | "Quality Gate" |
| **Graph-RAG context** | precision, recall, F1, false positive | "Security Hotspot" as a product noun |
| **verified fix** | code smell, technical debt *(both predate any of these products)* | Another product's severity ladder |
| **Fleet**, **Timeline** | severity, confidence, fingerprint, SARIF *(as an export)* | Their finding-detail UI layout |
| **analysis tier**, **coverage** | precision/recall benchmarking, corpora | Their onboarding metaphors |

Middle column is deliberately generous. Restricting standard terminology would make the codebase
harder to read for no gain — and being wrong in the restrictive direction costs credibility just
as much as copying does.

---

## 6. What identity does *not* mean

Guardrails on the guardrail. Every item below is a way this document could be misread into
making the product worse.

- **It does not mean reinventing solved problems.** Use worklist algorithms, use SSA, use
  content-addressed caching. Novelty in infrastructure is a cost, not a feature.
- **It does not mean refusing interoperability.** Exporting a standard format so CodeGraph works
  with a user's existing CI is serving the user, not surrendering identity.
- **It does not mean ignoring prior art.** Read everything. Understand why others chose what they
  chose. Then decide for CodeGraph.
- **It does not mean never comparing.** Honest comparison helps a reader decide. Just never lead
  with it, and never let it set the frame.
- **It does not mean the current implementation is sacred.** Identity is about *what CodeGraph
  is*, not *how v1 happened to build it*. The detection engine can be rewritten entirely without
  touching identity — indeed it should be.
- **It does not mean rejecting a good idea because someone else had it first.** Sanitizer
  modelling is a good idea. Adopt it. Just don't ship it under someone else's name, in someone
  else's syntax, with someone else's grades attached.

---

## 7. Review checklist

Before merging any design doc, README change, UI copy, or user-facing feature:

- [ ] Does this describe CodeGraph on its own terms, without naming a competitor first?
- [ ] Is every user-visible name from CodeGraph's vocabulary (§5) or plainly generic?
- [ ] Is the Health Score still the headline metric — no letter grade, no borrowed badge?
- [ ] Is any interchange format confined to the boundary, not the internal model?
- [ ] If it borrows something, is that thing *technique* (§3) rather than *identity*?
- [ ] Would a user of another tool recognise this as that tool's feature wearing our name?
- [ ] Does it keep the graph, the score, or the verified fix at the centre?

Any "no" is a blocking review comment.

---

## 8. The one-paragraph version

*For a README, a landing page, or an interview answer. Memorise this shape, not these exact
words.*

> CodeGraph turns a repository into a symbol-level graph you can actually look at — three
> interactive views of how your code really fits together. From that graph it computes an
> explainable Health Score, runs a deterministic swarm of specialists that argue findings out
> among themselves, and generates fixes it proves by running your own test suite before showing
> you a diff. Then you edit and commit without leaving. One container, one file, no API key,
> MIT.
