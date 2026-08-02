# ADR-009 — Cross-project calibration is the wrong target. One repo, deeply.

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-30 |
| **Supersedes** | PLAN.md §5.3's exit criterion |
| **Binding on** | `docs/design/IDENTITY.md` §4.4, §0 |

## Decision

**CodeGraph does not ship universal learned score weights, does not chase a cross-project ROC
AUC, and does not keep a corpus of other people's repositories.** The `k = 0.06` kernel stays
hand-picked and stays labelled as such. The calibration corpus, the fitting pipeline, and
`@codegraph/calibrate` are **deleted**.

> **Amended 2026-07-30, same day.** The first version of this ADR said the corpus and harness
> were "kept and retargeted to within-repository validation". That was half a decision. Nothing
> in the product imported them — only two scripts — and 784 KB of twelve other projects' git
> history sat in the tree as an invitation to re-run the wrong experiment. Retaining unused
> machinery "in case" is the exact pattern this branch spent five commits removing: a dead lint
> gate, an unpopulated `coverage_json`, a `bin` entry pointing at a file that did not exist.
>
> Within-repository validation does not need a corpus of strangers' repositories. It needs the
> repository in hand, which CodeGraph already has. If that work happens, it gets written then,
> for that purpose. What survives is this document — the reasoning is the durable artefact, not
> the code that produced it.

## Why the previous target was wrong

Not because the experiment failed. Because it answered a question this product does not ask.

Cross-project AUC asks: **"can weights learned from other people's repositories predict defects
in yours?"** That is the question a product must answer when it ships one universal model to
every user. It is the right question *for that shape of product*.

CodeGraph is a different shape, and says so in its own documents:

> **HLD §2.2, non-goals:** *"Cross-repo search at scale. Sourcegraph's domain. CodeGraph indexes
> one repo deeply."*

CodeGraph indexes **one repository** and holds **its entire git history** at index time. It has
no need to transfer weights from strangers' codebases, because it is never reasoning about a
codebase it has not indexed. Optimising for transfer is optimising for a constraint the product
does not have.

## How the mistake happened, recorded because the mechanism matters

IDENTITY.md §0 describes exactly this failure:

> *"the v2 design drifted toward importing **their** identity along with their techniques —
> another product's rule syntax, another product's letter grades, another product's output model
> as our internal one."*

The drift this time was subtler than a rule syntax. It was an **evaluation frame**. A prior-art
scan recorded a competitor's headline figure — 0.74 cross-project ROC AUC — and PLAN.md §5.3
adopted "beat that number" as an exit criterion. Two sessions were then spent building a corpus,
a leakage guard, a regression, and a bootstrap CI, all to move a metric that describes someone
else's product shape.

§4.4 bans positioning reactively. The ban applies to methodology, not just to marketing copy: an
exit criterion copied from a competitor's press page is a reactive position wearing a lab coat.

## The evidence, which points the same way

From `benchmarks/calibration/scorecard.json`, 12 repos, 1239 files, 192 defective:

| | pooled AUC | mean-per-repo |
|---|---|---|
| model (15 markers, L2 logistic, nested CV) | 0.537 | 0.673 |
| baseline: recent churn | 0.671 | 0.718 |
| baseline: file size | 0.730 | 0.717 |

The model loses. But the *shape* of the failure is the useful part. Measured predicted
probabilities on held-out repositories:

| repo | true defect rate | model's predictions |
|---|---|---|
| socket.io | 78% | max **0.269** |
| eslint | 11% | median **0.515** |

The model cannot know a held-out repository's base rate, because it never sees it. That is
**base-rate non-transfer**, and it is the dominant error term.

**It cannot occur within a single repository.** The failure mode being measured is one CodeGraph
never encounters — it always has the repository in hand. And per-repository discrimination was
already strong even with foreign weights: `psf/requests` 0.896, `psf/black` 0.867,
`python-attrs/attrs` 0.856.

So the number we were failing to beat was produced by a handicap the product does not wear.

## What this changes

**The Health Score stays as it is.** 0–100, aggregate, explainable, hand-weighted, reporting its
own coverage (ADR-008). It stays cross-repo comparable, which the Fleet view depends on, and
comparability is a reason *not* to fit per-repo weights into it.

**Per-file risk ranking is where history signals may earn their place** — the "what should I fix
first" ordering the swarm produces. That is a within-repository question by construction, and it
is validated per-repository against that repository's own history. A file list ordered for
*your* repo needs no commensurability with anyone else's.

**The corpus and harness are deleted.** `@codegraph/calibrate`, `benchmarks/calibration/`,
`npm run calibrate` and `npm run fit` are removed. Every measurement they produced is quoted in
this document, which is what a reader needs; the pipeline that produced it answers a question
the product does not ask, and leaving it in the tree is how someone re-asks it.

**What is explicitly NOT adopted:** a 21-marker signal list, a 1–10 scale, letter grades, or any
target expressed as a competitor's published figure. §4.2 and §4.4.

## Consequences

- PLAN.md §5.3's exit criterion ("cross-project ROC AUC beating both baselines") is retired. It
  is replaced by: *per-file risk ranking is validated against the indexed repository's own
  history, and the Health Score discloses that its weights are hand-picked.*
- The README claim stays what it already is: an explainable score that reports its coverage.
  No accuracy claim is made, because none is earned.
- Effort returns to the differentiators IDENTITY.md §1 names — the visible graph, verified
  remediation, and the closed loop — which is where P5 and P6 already point.

## What would reverse this

A within-repository validation showing the history-derived ranking beats file size **on the
indexed repository's own history**, with enough positives in that repository to mean anything.
That is a per-repo claim, checkable by the user on their own code, and it needs no corpus of
other people's projects to be true — which is why deleting the corpus costs nothing.
