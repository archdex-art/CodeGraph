import { describe, expect, it } from "vitest";
import { buildSymbolGraph, compileAsk, QueryEngine } from "@codegraph/core-graph";
import type { AskCorpus, AskEntityKind, AskIntent, AskPlan } from "@codegraph/core-graph";
import type { ApiSurface } from "@codegraph/core-graph";
import { intentsFor, phraseFor, type PlanDraft } from "@/lib/askPhrase";

/**
 * The Ask page's plan controls, checked against the compiler they are steering.
 *
 * WHY THIS TEST IS THE WHOLE FEATURE
 *
 * The controls do not execute a plan. They rewrite the compiled plan back into English, put it
 * in `?q=`, and let the existing pipeline compile it again - which means every control is a bet
 * that the sentence it writes will be read the way it was written. A control that generates a
 * question the compiler then misreads is worse than no control: the reader clicks INBOUND,
 * gets the outbound answer, and has no way to tell, because the words that flip direction in
 * this grammar ("does", verb adjacency) are invisible to anyone who did not write the parser.
 *
 * So the property is round-tripping, asserted exhaustively rather than by example:
 *
 *   compileAsk(phraseFor(draft)) === draft, over every draft the panel can produce.
 *
 * The enumeration is driven by `intentsFor`, the same table the select is drawn from, so a
 * phrasing that stops classifying fails here before it can ship. `INTENT_COVERAGE` is a
 * `Record<AskIntent, ...>`, so widening the compiler's intent union breaks this file at
 * compile time until the new intent is either given a control or written off in one place.
 */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

const surface: ApiSurface = {
  endpoints: [
    { id: "POST /orders", method: "POST", routePath: "/orders", file: "routes.ts", line: 4, framework: "express", handlerSymbolId: "h", pathIsDynamic: false, authenticated: false, authEvidence: null },
  ],
  flows: [],
  truncated: false,
};

async function corpus(): Promise<AskCorpus> {
  const graph = await buildSymbolGraph(
    [
      f("db.ts", "export function connect() { return 1; }\n"),
      f("service.ts", "import { connect } from './db';\nexport function loadOrder(id: string) { return connect(); }\n"),
      f("controller.ts", "import { loadOrder } from './service';\nexport function getOrder(id: string) { return loadOrder(id); }\n"),
    ],
    new Map(),
  );
  return {
    graph,
    api: surface,
    packageImporters: new Map([["redis", ["db.ts"]]]),
    fileImporters: new Map([["db.ts", ["service.ts"]], ["service.ts", ["controller.ts"]]]),
  };
}

/** One real thing of each kind, named exactly as the compiler would echo it back. */
const ENTITY: Record<AskEntityKind, { kind: AskEntityKind; label: string }> = {
  symbol: { kind: "symbol", label: "loadOrder" },
  file: { kind: "file", label: "service.ts" },
  package: { kind: "package", label: "redis" },
  endpoint: { kind: "endpoint", label: "POST /orders" },
};

/**
 * Which intents the panel steers, and which it refuses to.
 *
 * `callers` and `callees` are in `AskIntent` and the executor answers both, but no cue in the
 * compiler's table ever produces them - they exist only as `dependencies_of` plus a direction.
 * A select option for either would compile to a third thing every time it was used, so there
 * is no control for them and this is the record of that decision.
 *
 * `search` is different again: it is what an UNPARSEABLE question degrades to, so offering it
 * as a choice would mean synthesising a question the compiler is guaranteed not to understand.
 *
 * The record is exhaustive on purpose - adding an intent is a type error here until someone
 * decides, deliberately, whether the panel should steer it.
 */
const INTENT_COVERAGE: Record<AskIntent, "controlled" | "no cue produces it"> = {
  search: "no cue produces it",
  ownership: "controlled",
  stale: "controlled",
  packages: "controlled",
  unused_packages: "controlled",
  impact: "controlled",
  dependencies_of: "controlled",
  package_dependents: "controlled",
  explain_flow: "controlled",
  symbol_search: "controlled",
  endpoints: "controlled",
  unauthenticated: "controlled",
  dead_code: "controlled",
  cycles: "controlled",
  hubs: "controlled",
  untested: "controlled",
  callers: "no cue produces it",
  callees: "no cue produces it",
};

/** `impact` and `package_dependents` are forced inbound; only the dependency walk is steerable. */
function expectedDirection(draft: PlanDraft): AskPlan["direction"] {
  if (draft.intent === "impact" || draft.intent === "package_dependents") return "inbound";
  return draft.intent === "dependencies_of" ? draft.direction : "none";
}

/** The three intents whose plan carries a walk. Everything else is a single-shot query. */
const WALKS: readonly AskIntent[] = ["impact", "package_dependents", "dependencies_of"];

const KINDS: Array<AskEntityKind | null> = [null, "symbol", "file", "package", "endpoint"];

/**
 * Every draft the controls can produce, as `[name, draft]` for `it.each`.
 *
 * `intentsFor(null)` IS the whole-repository set, so it is read back rather than restated:
 * picking one of those from an entity-bearing question drops the entity, which is what the
 * panel does and what the synthesised sentence has to reflect. Enumerating them once, under
 * the null kind, also keeps the matrix from repeating six identical cases per entity kind.
 */
function drafts(): Array<[string, PlanDraft]> {
  const out: Array<[string, PlanDraft]> = [];
  const wholeRepo = new Set(intentsFor(null));
  for (const kind of KINDS) {
    for (const intent of intentsFor(kind)) {
      if (kind !== null && wholeRepo.has(intent)) continue;
      const entity = kind === null ? null : ENTITY[kind];
      const directions: Array<AskPlan["direction"]> = intent === "dependencies_of" ? ["inbound", "outbound"] : ["none"];
      for (const direction of directions) {
        for (const transitive of [false, true]) {
          out.push([
            `${intent} · ${kind ?? "no entity"} · ${direction} · ${transitive ? "transitive" : "direct"}`,
            { intent, entity, direction, transitive },
          ]);
        }
      }
    }
  }
  return out;
}

describe("ask plan controls: synthesised questions compile back to the plan that was asked for", () => {
  it.each(drafts())("%s", async (_name, draft) => {
    const c = await corpus();
    const question = phraseFor(draft);
    if (question === null) throw new Error("the controls offered an intent no phrase can express");

    const plan = compileAsk(question, c, new QueryEngine(c.graph));
    if ("ok" in plan) throw new Error(`"${question}" was refused: ${plan.message}`);

    expect(plan.intent).toBe(draft.intent);
    expect(plan.direction).toBe(expectedDirection(draft));
    // A non-walking intent must not pick up transitivity by accident: its phrase carries no
    // adverb, so the flag the panel is holding has to be dropped rather than smuggled through.
    expect(plan.transitive).toBe(WALKS.includes(draft.intent) ? draft.transitive : false);
    // Depth is a consequence of the walk, which is why no stepper is offered.
    expect(plan.depth).toBe(plan.transitive ? 4 : 1);
    expect(plan.entity?.kind ?? null).toBe(draft.entity?.kind ?? null);
    expect(plan.entity?.label ?? null).toBe(draft.entity?.label ?? null);
  });

  it("offers a control for every intent except the ones no sentence can reach", () => {
    const offered = new Set(KINDS.flatMap((k) => [...intentsFor(k)]));
    for (const [intent, status] of Object.entries(INTENT_COVERAGE) as Array<[AskIntent, string]>) {
      expect(offered.has(intent), `${intent} is ${status}`).toBe(status === "controlled");
    }
  });

  it("refuses to invent a sentence for an intent the grammar cannot reach", () => {
    for (const intent of ["callers", "callees"] as const) {
      expect(phraseFor({ intent, entity: ENTITY.symbol, direction: "inbound", transitive: false })).toBeNull();
    }
  });

  it("returns nothing rather than a half-formed question when the entity is blank", () => {
    // The page keeps the last answer on screen while the entity box is empty; a phrase built
    // from "" would compile to `entity_not_found` and throw away an answer the reader still
    // wanted, so the caller gets a null and does not navigate.
    for (const intent of ["impact", "dependencies_of", "symbol_search", "explain_flow", "package_dependents"] as const) {
      expect(phraseFor({ intent, entity: { kind: "symbol", label: "  " }, direction: "outbound", transitive: false })).toBeNull();
      expect(phraseFor({ intent, entity: null, direction: "outbound", transitive: false })).toBeNull();
    }
  });

  it("keeps the entity out of the parser's way when it is edited to something new", async () => {
    // The whole point of an editable entity: the same intent, re-aimed. `getOrder` is a
    // different symbol in a different file, and nothing about the sentence changes but the name.
    const c = await corpus();
    const plan = compileAsk(phraseFor({ intent: "impact", entity: { kind: "symbol", label: "getOrder" }, direction: "inbound", transitive: true })!, c, new QueryEngine(c.graph));
    if ("ok" in plan) throw new Error(plan.message);
    expect(plan.entity?.label).toBe("getOrder");
    expect(plan.operations).toEqual(["QueryEngine.impactWithHops(depth=4)"]);
  });

  /**
   * `ownership` is the one intent the panel offers at two scopes, so the exhaustive matrix
   * above cannot cover it: that matrix skips whole-repository intents for every non-null kind,
   * and `ownership` is in both lists on purpose. The scoped sentence is the interesting half —
   * it has to RE-BIND the entity, and for a file that only became possible once `normalise`
   * stopped stripping the dot out of `service.ts`.
   */
  it.each([["file", ENTITY.file], ["symbol", ENTITY.symbol]] as const)("re-binds a %s when ownership is scoped to one", async (kind, entity) => {
    const c = await corpus();
    const question = phraseFor({ intent: "ownership", entity, direction: "none", transitive: false });
    expect(question).toBe(`who owns ${entity.label}`);
    const plan = compileAsk(question!, c, new QueryEngine(c.graph));
    if ("ok" in plan) throw new Error(`"${question}" was refused: ${plan.message}`);
    expect(plan.intent).toBe("ownership");
    expect(plan.entity?.kind).toBe(kind);
    expect(plan.entity?.label).toBe(entity.label);
  });

  it("offers ownership exactly once even though it is listed at both scopes", () => {
    // Two identical options in a select is a bug the round-trip property cannot see: both
    // compile to the same plan, and the reader cannot tell them apart.
    for (const kind of KINDS) {
      const offered = [...intentsFor(kind)];
      expect(new Set(offered).size, `${kind ?? "no entity"}: ${offered.join(", ")}`).toBe(offered.length);
    }
  });
});
