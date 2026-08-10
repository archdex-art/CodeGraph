import type { AskEntityKind, AskIntent, AskPlan } from "@codegraph/core-graph";

/**
 * Turning a compiled plan back into a question the compiler is guaranteed to accept.
 *
 * WHY THE CONTROLS EMIT ENGLISH RATHER THAN A PLAN
 *
 * Measured recall of the Ask classifier is 78%: roughly one question in five is classified
 * wrongly or refused outright, and the reader's only recourse today is to guess a different
 * phrasing. Making the receipt editable removes the guessing. The obvious implementation -
 * POST the edited plan and execute it directly - would add a second way into the query
 * engine, and the two paths would drift the first time a cue changed. So the controls write a
 * QUESTION instead: they synthesise the canonical sentence for the plan the reader asked for,
 * put it in `?q=`, and the existing compile-and-execute path runs unchanged. One code path,
 * one URL that is still shareable, and the receipt on screen is still the plan that actually
 * ran rather than the plan that was requested.
 *
 * That last point is what makes the approach safe. If a synthesised sentence compiles to
 * something other than what the control said - an entity whose name is itself a grammar cue,
 * say, like a symbol literally called `cycle` - the reader sees the mismatch in the receipt
 * immediately, because the receipt is rendered from the compiler's output and never from the
 * draft that produced it.
 *
 * WHY THE PHRASES LIVE HERE AND NOT IN THE PAGE
 *
 * Every sentence below is asserted to round-trip through `compileAsk` in
 * `apps/web/tests/ask-phrase.test.ts`. A phrasing that is inlined at a callsite is a phrasing
 * nobody can test as a set, and a control that generates a question the compiler then misreads
 * is worse than no control at all.
 */

/** The subset of the plan the controls own. `AskPlan` is assignable to it. */
export interface PlanDraft {
  readonly intent: AskIntent;
  readonly entity: { readonly kind: AskEntityKind; readonly label: string } | null;
  readonly direction: AskPlan["direction"];
  readonly transitive: boolean;
}

/**
 * Intents the controls offer for a given entity kind, in the order they are listed.
 *
 * The binding is not cosmetic. Three rules force it:
 *
 * `compileAsk` refines an intent by the kind of thing the entity turned out to be - a
 * dependency question about an external package becomes `package_dependents`, and
 * `explain_flow` about anything that is not an endpoint becomes `dependencies_of`. Offering
 * `dependencies_of` for a package would offer a choice the compiler is going to overrule.
 *
 * The executor answers a non-symbol entity from a different branch. `impact` on a file runs
 * `impactWithHops` against a path that is not a symbol id and comes back empty, which reads as
 * "changing this file breaks nothing" - a confident wrong answer, which is the one thing this
 * surface is built not to produce.
 *
 * A file used to get NO entity-bearing intent, because `normalise` stripped `.` from the
 * question before `tokenise` saw it: "who calls service.ts" reached the resolver as the two
 * words `service` and `ts` while the file branch compared against paths that still had their
 * extension, so no file had ever bound. That is fixed - a dot between two characters now
 * survives - and `ownership` is the intent worth offering over a file, because "who owns this
 * file" is the question a reader has when looking at one. Verified by round-trip against the
 * compiler, not assumed; see `ask-phrase.test.ts`.
 *
 * A file still gets no `impact` or `dependencies_of`, for the reason above: those run against
 * a symbol id, and a path is not one.
 */
const BY_KIND: Record<AskEntityKind, readonly AskIntent[]> = {
  symbol: ["impact", "dependencies_of", "symbol_search", "ownership"],
  file: ["ownership"],
  package: ["package_dependents"],
  endpoint: ["explain_flow"],
};

/**
 * Intents that answer for the whole repository. Selecting one leaves the entity in the draft
 * and `phraseFor` writes a sentence that ignores it, which is how the panel "drops" it.
 *
 * `ownership` is in this list AND in `BY_KIND`, because it is the one intent that means
 * something at both scopes: "who wrote this code" and "who owns src/store.ts" are the same
 * query with and without a subject. `intentsFor` de-duplicates so the select never shows it
 * twice, keeping the entity-bearing position when there is an entity to bear.
 */
const WHOLE_REPO: readonly AskIntent[] = ["endpoints", "unauthenticated", "cycles", "hubs", "dead_code", "untested", "ownership", "stale", "packages", "unused_packages"];
/**
 * Every intent the controls can reach, given what the current question bound.
 *
 * `callers` and `callees` are deliberately absent. They exist in `AskIntent` and the executor
 * answers them, but no cue in the compiler's table produces them - they are reachable only as
 * `dependencies_of` with a direction - so no sentence can round-trip to either one. Listing
 * them would put two options in the select that silently compile to a third.
 *
 * De-duplicated because `ownership` appears in both lists. First occurrence wins, so with an
 * entity bound it keeps the entity-bearing position and `phraseFor` writes the scoped
 * sentence; with nothing bound there is only the whole-repository one to find.
 */
export function intentsFor(kind: AskEntityKind | null): readonly AskIntent[] {
  return kind === null ? WHOLE_REPO : [...new Set([...BY_KIND[kind], ...WHOLE_REPO])];
}

/*
 * The two predicates below decide which toggles are DRAWN, not what `phraseFor` honours.
 * `phraseFor` always spells out the direction and transitivity it is given, so a hidden toggle
 * still round-trips whatever the last question set. They are separate questions: the grammar
 * can say a thing, and the answer changes when it does.
 */

/**
 * Only the dependency walk has two ends, and only over a symbol.
 *
 * A file entity is answered by the executor's non-symbol branch - the symbols the file defines
 * - before direction is ever read, so a toggle there would move a word in the receipt without
 * moving a single row.
 */
export function directionApplies(draft: PlanDraft): boolean {
  return draft.intent === "dependencies_of" && draft.entity?.kind === "symbol";
}

/**
 * Whether widening the walk changes the answer.
 *
 * `impact` and `package_dependents` always walk, so the toggle narrows them to one hop.
 * Outbound dependencies widen from `callees()` to `reachableCallees()`. Inbound dependencies
 * are the exception: `callers()` answers them either way.
 *
 * There is no companion depth control, for a related reason. Depth is not a free parameter of
 * the grammar: `transitivityOf` reads the words "direct" and "transitive" and nothing else, so
 * the only depths a sentence can name are 1 and the compiler's default. A stepper would have
 * to invent a phrase for "depth 3" that the compiler would then read as depth 4, which is
 * exactly the failure this panel exists to prevent. Depth is shown, read-only, beside the
 * toggle that actually determines it.
 */
export function transitiveApplies(draft: PlanDraft): boolean {
  if (draft.intent === "impact" || draft.intent === "package_dependents") return true;
  return draft.intent === "dependencies_of" && draft.direction === "outbound" && draft.entity?.kind === "symbol";
}

/**
 * The canonical question for a draft, or `null` when the draft names no entity for an intent
 * that requires one.
 *
 * Word order is load-bearing in three places and every one of them was chosen against the
 * compiler's own rules rather than for how the sentence reads:
 *
 *   - "directly" goes BEFORE the verb. It is folded to the cue `direct`, and the entity
 *     resolver drops it as a known synonym, so it cannot be mistaken for the subject.
 *   - "transitively" goes AFTER the entity. `directionOf` decides inbound with
 *     `/(who|what|which)\s+(calls?|uses?|imports?)/`, which needs the verb adjacent to the
 *     pronoun; "who transitively calls X" fails that test and falls through to outbound,
 *     inverting the question.
 *   - the outbound form keeps the auxiliary "does", which is the single token that separates
 *     "what does X use" from "what uses X".
 */
export function phraseFor(draft: PlanDraft): string | null {
  const label = draft.entity?.label.trim() ?? "";
  /* `impact` and `package_dependents` walk by default, so narrowing them needs a word.
     `dependencies_of` is the mirror image: one hop by default, so widening it needs one. */
  const direct = draft.transitive ? "" : "directly ";
  const transitively = draft.transitive ? " transitively" : "";

  switch (draft.intent) {
    /*
     * `search` is the FALLBACK, not a choice. It is what an unparseable question degrades to,
     * so there is no canonical sentence that produces it — asking for one would mean writing a
     * question the compiler is guaranteed NOT to understand, which is absurd as a control.
     * Returning null removes it from the panel, which is the right answer.
     */
    case "search":
      return null;
    case "impact":
      return label ? `what ${direct}breaks if I change ${label}` : null;
    case "package_dependents":
      return label ? `what ${direct}depends on ${label}` : null;
    case "dependencies_of":
      if (!label) return null;
      return draft.direction === "inbound"
        ? `who calls ${label}${transitively}`
        : `what does ${label} use${transitively}`;
    case "explain_flow":
      return label ? `explain ${label}` : null;
    case "symbol_search":
      return label ? `where is ${label} defined` : null;
    case "endpoints":
      return "what are the endpoints";
    case "unauthenticated":
      return "which endpoints are unauthenticated";
    case "cycles":
      return "what are the circular dependencies";
    case "hubs":
      return "what are the hubs";
    case "dead_code":
      return "what is dead code";
    case "untested":
      return "what is untested";
    /*
     * The one intent with two canonical sentences, chosen by whether anything is bound. Both
     * compile back to `ownership`; the scoped one also has to re-bind the entity, which is
     * only possible because `normalise` now leaves the dot in `src/store.ts` alone.
     */
    case "ownership":
      return label ? `who owns ${label}` : "who wrote this code";
    case "stale":
      return "which files are stale";
    case "packages":
      return "what packages does this repository use";
    case "unused_packages":
      return "which packages are unused";
    // See `intentsFor`: no cue produces these, so no sentence can round-trip to them.
    case "callers":
    case "callees":
      return null;
  }
}
