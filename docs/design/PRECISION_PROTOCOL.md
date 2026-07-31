# Detection precision — labelling protocol

| | |
|---|---|
| **Status** | Pre-registered. Written and committed **before** any finding was sampled or scored. |
| **Date** | 2026-07-30 |
| **Purpose** | Give PLAN.md P5.3 the labelled corpus it is blocked on, at a size that is honest about what it can support. |

---

## 0. Why this is written first

P5.3's exit is *"precision ≥ 0.85 overall and ≥ 0.90 for anything emitting at P0"*. That is a
claim about whether reported findings are real, which no amount of mechanical measurement can
settle — someone has to read them.

`ADR-009` records what happens when a target is adopted before the method is examined: two
sessions spent fitting toward a number that turned out to be the wrong question. The defence
that worked for the calibration corpus was writing the selection criteria down before scoring
anything, so the rules could not be adjusted once the results were visible. Same defence here.

**Committed before sampling.** The git history is the evidence; if these rules were tuned to
flatter a result, the commit order would show it.

---

## 1. What is being measured

**Precision only.** Of the findings CodeGraph reports, what fraction describes something real?

Recall is explicitly **out of scope**: it needs a list of every defect in the corpus, which
nobody has. Reporting precision alone, and saying so, beats reporting an F1 built on a
denominator that was guessed.

---

## 2. Sampling

1. Corpora: `expressjs/express@a371447` (third-party, pinned) and this repository (self).
2. Take **every** finding each produces, then select with a **fixed stride** over the list as
   the tool orders it — not a random draw, so re-running reproduces the identical sample
   without storing a seed.
3. Target ~50 findings total, split across both corpora.
4. **The sample is fixed once drawn.** A finding that turns out to be awkward to judge is
   labelled `unclear` (§3) and stays in the denominator. Removing it would be the exact move
   this document exists to prevent.

---

## 3. Labels

Each sampled finding gets exactly one:

| Label | Meaning |
|---|---|
| `true` | The thing the finding describes is present at that location and the description is accurate. |
| `false` | The thing is not present, or the location is wrong, or the description does not match what is there. |
| `unclear` | Genuinely cannot be decided from the file alone. |

**Precision = `true` / (`true` + `false` + `unclear`)** — `unclear` counts AGAINST. A finding a
careful reader cannot adjudicate is not doing its job, and putting it in the numerator or
dropping it from the denominator would both flatter the result.

### Decision rules, fixed in advance

These exist so that judgement is applied consistently rather than per finding:

1. **Style is not a defect, but the rule decides what it claims.** "Leftover debug output" is
   `true` if a `console.log` is genuinely there in shipped code, regardless of whether anyone
   minds. The finding claims presence, not importance.
2. **Test and example files count normally.** A real `eval()` in a test is really an `eval()`.
   Whether it *matters* is severity's job, not precision's.
3. **A finding pointing at a comment or string when it claims code is `false`.** That is the
   context gate's whole purpose.
4. **Placeholders are `false` for secrets.** `'keyboard cat'` in an examples directory is a
   documentation placeholder, not a credential.
5. **A finding whose title over-claims relative to what is present is `false`.** A regex that
   provably does not backtrack is not a "ReDoS-vulnerable regular expression"; measurement
   settles it, not the pattern's shape.
6. **Location is part of the claim.** Right kind of problem, wrong line, is `false`.

---

## 4. Reporting

- Precision as a fraction with a **Wilson score 95% interval**, which behaves at small n where
  the normal approximation does not.
- The **per-rule breakdown**, because one noisy rule at volume can sink an otherwise sound set,
  and an aggregate hides that.
- The **full labelled list**, so anyone can disagree with a specific call rather than the total.

## 5. What this cannot support

Stated up front, not as a caveat afterwards:

- **The labels are the implementer's.** This is an internal estimate, not independent
  adjudication. Someone who did not write the rules should re-label the same sample before this
  number is used to make a claim to anyone else.
- **~50 findings is a small sample.** The interval will be wide and must be quoted with the
  point estimate, never without.
- **Two repositories, one of them our own.** Self-analysis is not representative; the split is
  reported separately for that reason.
- **Precision on findings the tool DID report** says nothing about what it missed.
