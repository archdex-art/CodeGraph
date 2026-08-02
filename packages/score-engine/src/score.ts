import {
  DIMENSION_META,
  PILLAR_META,
  pillarsFrom,
  type Dimension,
  type DimensionScore,
  type Issue,
  type PillarScore,
} from "@codegraph/analysis-model";

/**
 * The Health Score model, extracted from the analysis pipeline (LLD §13).
 *
 * **The coupling this removes.** `agents/orchestrator.ts` computes the swarm's projected score
 * by re-running the real scorer rather than estimating it (review item C5) - which is right,
 * and which meant importing `scoreIssues` from the indexer. Scoring a hypothetical list of
 * findings therefore dragged in the file walker, the ESLint layer, the TypeScript program
 * builder and the taint analysis. The score model depends on none of it.
 *
 * Prompted by CodeGraph's own output: `Large file (1259 LOC)` on `indexer.ts` was the top
 * finding when the product was run on itself, and the file it names is the one this branch
 * kept adding to.
 *
 * Everything here is a pure function of findings plus LOC. No I/O, no filesystem, no parser -
 * which is what makes the golden table in `tests/` meaningful.
 */

/**
 * The per-(rule, file) emit cap.
 *
 * Lives here rather than in the pipeline because it is what `volumeMultiplier` measures excess
 * AGAINST: the pipeline stops emitting at this many matches, and the multiplier turns anything
 * beyond it into weight. Two copies of the number would let the cap and the scale disagree
 * silently.
 */
export const HITS_PER_RULE_PER_FILE = 5;

/**
 * Damped blast-radius multiplier.
 *
 * Fixes review item B2. The raw model was `penalty = severity × blastRadius`
 * with `blastRadius = 1 + fanIn`, which inverted the ranking it was selling: a
 * `TODO` (severity 1) in a file imported 60× scored 61, while an `eval()`
 * (severity 5) in a leaf file scored 5 — the TODO outranking the eval 12:1. The
 * README calls the score "blast-radius-weighted, explainable"; it was weighted
 * in a way that systematically buried the findings that matter.
 *
 * Log damping is what `judgeScore` in agents/orchestrator.ts already did
 * (`1 + log2(1 + blastRadius)`), so this also makes the two scorers agree
 * instead of ranking the same finding differently.
 *
 * The cap is the load-bearing part. Without it, damping alone still lets a
 * severity-1 finding in a sufficiently-imported file outrank a severity-5 one
 * (at fanIn ≈ 1000 the multiplier reaches ~11). At 8 — which log2 reaches around
 * fanIn 127 — the worst a severity-1 finding can contribute is 8, while the
 * least a severity-5 finding can contribute is 5 × 2 = 10. So severity 5 always
 * outranks severity 1, whatever the graph looks like, and that invariant is
 * asserted in the tests.
 *
 * Blast radius stays deliberately file-level here. Symbol-level reachability
 * (`QueryEngine.reachableCallers`) is the real answer and is P3 work — it needs
 * findings to carry a symbol, which the regex rules cannot supply.
 */
const MAX_BLAST_MULTIPLIER = 8;

function blastMultiplier(blastRadius: number): number {
  return Math.min(MAX_BLAST_MULTIPLIER, 1 + Math.log2(1 + Math.max(0, blastRadius)));
}

/**
 * Volume multiplier for a rule that matched many times in one file.
 *
 * Fixes review item B3. `analyzeFiles` stops emitting after
 * `HITS_PER_RULE_PER_FILE` matches, which is a sensible bound on the issue list
 * and on memory — but it was also doing metric duty, so a file with 500
 * `console.log`s and a file with 5 scored identically, and deleting 400 of them
 * moved the score by zero.
 *
 * Returns exactly 1 at or below the cap, so every repository whose files are
 * under it scores precisely as it did before — the common case is unchanged.
 * Past the cap, volume registers logarithmically: 10× the cap roughly triples
 * the contribution rather than multiplying it by ten.
 */
function volumeMultiplier(occurrences: number | undefined): number {
  if (occurrences === undefined || occurrences <= HITS_PER_RULE_PER_FILE) return 1;
  return 1 + Math.log2(occurrences / HITS_PER_RULE_PER_FILE);
}

/**
 * Expected harm from one finding — the single weighting both the score and the displayed
 * order use.
 *
 *   severity × blastMultiplier × volumeMultiplier × confidence
 *
 * **Why confidence belongs here (PLAN.md §5.2).** The scorer stored `confidence` on every
 * finding and then ignored it, so a 0.7 "Possible SQL string concatenation" weighed exactly as
 * much as a 0.95 `eval()`. `severity` and `confidence` are orthogonal axes, and the rule table
 * proves it rather than merely asserting it: `Use of eval()` and `Possible hardcoded secret`
 * are BOTH severity 5. The uncertain one is not severity-discounted, because severity means
 * *impact if real*. Multiplying by P(real) is therefore an expectation, not a double-count.
 *
 * **This raises scores, and that is the correction, not generosity.** The old model charged
 * every guess at full price. `k = 0.06` is deliberately NOT rescaled to hold the old headline:
 * re-tuning a hand-picked constant to conceal a deliberate change is how a number stops
 * meaning anything. The pillar split above moved the headline for the same kind of reason.
 *
 * `?? 1` — absent means *unqualified*, so no discount. Defaulting to 0 would silently delete
 * every finding from a producer that does not set the field.
 *
 * One function, not two expressions kept in step by a comment: `scoreIssues` and the issue
 * ordering in `indexRepo` MUST apply identical weights, or the list disagrees with the number
 * it explains (review item B2, which surfaced twice).
 */
export function expectedHarm(i: Issue): number {
  return (
    i.severity *
    blastMultiplier(i.blastRadius) *
    volumeMultiplier(i.occurrences) *
    (i.confidence ?? 1)
  );
}

/**
 * The Health Score model.
 *
 *   penalty  = Σ severity × blastMultiplier × volumeMultiplier × confidence
 *   subScore = 100 × exp(-k · penalty / sizeFactor)
 *
 * Larger codebases tolerate more raw penalty (normalised by LOC).
 *
 * ONE KERNEL, THREE PILLARS (PLAN.md §5.1). The formula above runs per dimension exactly as
 * it always did; what changed is the aggregation above it. `overall` used to blend all five
 * dimensions, which meant the headline mixed "how likely is this to break" with "how hard is
 * this to work in" — maintainability alone was 0.22 of a number presented as risk.
 *
 * `overall` is now the DEFECT RISK pillar alone. The other pillars are returned beside it and
 * are never averaged in. This moves every repository's headline number, deliberately: the old
 * one answered a question nobody asked.
 *
 * Exported so the swarm's projected score is a real simulation through this exact function
 * rather than a parallel guess at it (review item C5).
 *
 * `depCount` used to be a third parameter and was never read in the body — the dependency
 * count reaches the score only through the findings it produces. Removed rather than left
 * standing as a claim about what the model weighs.
 */
export function scoreIssues(
  issues: Issue[],
  loc: number,
): { dimensions: DimensionScore[]; overall: number; pillars: PillarScore[] } {
  const sizeFactor = Math.max(1, Math.log10(Math.max(loc, 10)) ** 2); // ~1 small → ~10 huge
  const k = 0.06;

  const dims: DimensionScore[] = (Object.keys(DIMENSION_META) as Dimension[]).map((dim) => {
    const di = issues.filter((i) => i.dimension === dim);
    const penalty = di.reduce((s, i) => s + expectedHarm(i), 0);
    const norm = penalty / sizeFactor;
    const sub = 100 * Math.exp(-k * norm);
    return {
      dimension: dim,
      score: Math.round(Math.max(0, Math.min(100, sub))),
      penalty: Math.round(penalty * 10) / 10,
      issueCount: di.length,
    };
  });

  const pillars = pillarsFrom(dims);

  // The surfaced number is the defect-risk pillar, and only it.
  const surfaced = pillars.find((p) => PILLAR_META[p.pillar].surfaced);
  return { dimensions: dims, overall: surfaced?.score ?? 0, pillars };
}
