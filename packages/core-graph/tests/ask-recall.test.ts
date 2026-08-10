import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";
import { ask } from "../src/ask";
import type { AskCorpus, AskIntent } from "../src/ask";
import type { ApiSurface } from "../src/api";

/**
 * The question bank, and the floor it holds.
 *
 * WHY THIS FILE EXISTS
 *
 * `ask.test.ts` tests the phrasings the compiler was WRITTEN against, which is a test of the
 * author's memory. This is the other half: forty-one questions phrased the way a developer
 * actually types, most of which the author did not have in mind. First measured run scored
 * **25/32 in-grammar (78%)** with **4 confident misfires**, including
 *
 *   "which routes have no auth"      -> answered "36 endpoints declared"   (negation ignored)
 *   "how do I run the tests"         -> bound to a symbol `run` in an archived docs directory
 *
 * A keyword classifier drifts silently. Without a number in CI, every change to the cue table
 * is a guess, and a guess is how the table reached 78% in the first place.
 *
 * TWO PROPERTIES, DELIBERATELY DIFFERENT IN KIND
 *
 *  1. `MISFIRES` is a HARD ZERO. Answering a question the reader did not ask is the failure the
 *     whole design exists to avoid: the plan receipt is meaningless if the plan is confidently
 *     about something else. A refusal is not a misfire.
 *  2. `RECALL_FLOOR` is a RATCHET. It is allowed to be imperfect, it is not allowed to regress.
 *     Raise it when you improve the compiler; never lower it to make a change pass.
 */

/**
 * Never lower this. Raise it when the compiler improves, and say what changed.
 *
 * 25 -> 32 (all of them): negation and polarity, `find`/`blast radius`/`usages` vocabulary,
 * superlative-plus-dependency reading as a ranking question, and a confidence floor on entity
 * binding that stopped `run` in an archived directory from answering "how do I run the tests".
 */
const RECALL_FLOOR = 33; // of 33 in-grammar questions

const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });
const isTest = (file: string) => /\.test\.ts$/.test(file) || /(^|\/)tests?\//.test(file);

/**
 * A fixture with the SHAPES that broke on the real repository, not a tidy toy.
 *
 * `run` exists only inside `docs/archive/**` because that is exactly what "how do I run the
 * tests" latched onto: a stray symbol in a directory nobody would want an answer from.
 */
async function corpus(): Promise<AskCorpus> {
  const graph = await buildSymbolGraph(
    [
      f("src/indexer.ts", "import { buildVizGraph } from './viz';\nexport function indexRepo(root: string) { return buildVizGraph(root); }\n"),
      f("src/viz.ts", "export function buildVizGraph(root: string) { return packageOf(root); }\n"),
      f("src/packages.ts", "export function packageOf(spec: string) { return spec.split('/')[0]; }\n"),
      f("src/orphan.ts", "export function neverCalled() { return 1; }\n"),
      f("tests/indexer.test.ts", "import { indexRepo } from '../src/indexer';\nit('works', () => { indexRepo('.'); });\n"),
      // The junk-binding trap: a plausible common word, in a directory nobody means.
      f("docs/archive/legacy/test_extractors.ts", "export function run() { return 2; }\n"),
    ],
    new Map(),
  );
  const api: ApiSurface = {
    endpoints: [
      { id: "POST /api/index", method: "POST", routePath: "/api/index", file: "src/routes.ts", line: 4, framework: "next", handlerSymbolId: "h", pathIsDynamic: false, authenticated: false, authEvidence: null },
      { id: "GET /api/health", method: "GET", routePath: "/api/health", file: "src/routes.ts", line: 9, framework: "next", handlerSymbolId: "h2", pathIsDynamic: false, authenticated: true, authEvidence: "requireAuth" },
    ],
    flows: [],
    truncated: false,
  };
  return {
    graph,
    api,
    packageImporters: new Map([["react", ["src/viz.ts"]], ["lucide-react", ["src/viz.ts"]], ["typescript", []]]),
    fileImporters: new Map([["src/viz.ts", ["src/indexer.ts"]]]),
  };
}

/**
 * `null` = outside the documented grammar; a refusal is the CORRECT answer.
 *
 * The optional third element pins DIRECTION. It is only present where getting it wrong would
 * return the opposite set rather than no set - intent alone is not the answer for a caller
 * question, and the eval missed a real inversion until it checked this too.
 */
const BANK: ReadonlyArray<readonly [string, AskIntent | null, ("inbound" | "outbound")?]> = [
  ["what breaks if I change indexRepo", "impact"],
  ["what will break if I modify indexRepo", "impact"],
  ["if I rename indexRepo what else has to change", "impact"],
  ["who is affected by changing indexRepo", "impact"],
  ["what is the blast radius of indexRepo", "impact"],
  // Direction is pinned on these because intent alone is not the answer: every one of them is
  // `dependencies_of`, and getting the direction wrong returns the OPPOSITE set with the same
  // confidence. Four of them are passive forms, which is what people type when they want
  // callers, and all four used to fall through to the outbound fallback.
  ["who calls buildVizGraph", "dependencies_of", "inbound"],
  ["what calls buildVizGraph", "dependencies_of", "inbound"],
  ["where is buildVizGraph used", "dependencies_of", "inbound"],
  ["show me usages of buildVizGraph", "dependencies_of", "inbound"],
  ["what is buildVizGraph called by", "dependencies_of", "inbound"],
  ["what does indexRepo call", "dependencies_of", "outbound"],
  ["what does indexRepo depend on", "dependencies_of", "outbound"],
  ["what depends on react", "package_dependents"],
  ["which files import react", "package_dependents"],
  ["who uses lucide-react", "package_dependents"],
  ["is typescript actually used", "package_dependents"],
  ["which endpoints are unauthenticated", "unauthenticated"],
  ["which routes have no auth", "unauthenticated"],
  ["are there any unprotected endpoints", "unauthenticated"],
  ["list the api endpoints", "endpoints"],
  ["what routes does this expose", "endpoints"],
  ["what are the circular dependencies", "cycles"],
  ["is there any circular imports", "cycles"],
  ["what code is dead", "dead_code"],
  ["what is unused", "dead_code"],
  ["what has no tests", "untested"],
  ["which functions are untested", "untested"],
  ["what are the most important functions", "hubs"],
  ["what is most depended upon", "hubs"],
  ["where is packageOf defined", "symbol_search"],
  ["find the function called packageOf", "symbol_search"],
  ["explain POST /api/index", "explain_flow"],
  ["how does POST /api/index work", "explain_flow"],
  // Outside the grammar. Every one of these must be refused, not guessed at.
  ["how many lines of code are there", null],
  ["what is the health score", null],
  ["who owns src/indexer.ts", null],
  ["who should review this change", null],
  ["what changed recently", null],
  ["is this code secure", null],
  ["what should I fix first", null],
  ["how do I run the tests", null],
  ["what does this repository do", null],
];

describe("ask: recall against questions the compiler was not written for", () => {
  it("never answers a question the reader did not ask, and holds the recall floor", async () => {
    const c = await corpus();
    const misfires: string[] = [];
    const missed: string[] = [];
    let correct = 0;

    for (const [q, expected, direction] of BANK) {
      const r = ask(q, c, isTest);
      if (expected === null) {
        /*
         * Out of grammar. `search` is the CORRECT outcome, not a failure: the compiler says
         * on the receipt that it did not understand and returns ranked matches instead of a
         * dead end. What must never happen is a PRECISE intent — answering "who wrote this
         * code" as a call-graph query is the confident wrong answer this design exists to
         * avoid, and it is indistinguishable from a real answer to the reader.
         */
        if (r.ok && r.plan.intent !== "search") {
          misfires.push(`"${q}" was answered as ${r.plan.intent} — expected search or a refusal`);
        }
        continue;
      }
      if (!r.ok) missed.push(`"${q}" → refused (${r.reason})`);
      else if (r.plan.intent !== expected) misfires.push(`"${q}" → ${r.plan.intent}, expected ${expected}`);
      // A wrong direction is a MISFIRE, not a miss: it returns the opposite set, confidently.
      else if (direction && r.plan.direction !== direction) {
        misfires.push(`"${q}" → ${r.plan.intent} ${r.plan.direction}, expected ${direction}`);
      } else correct++;
    }

    // Reported before the assertions so a failing run names every regression at once rather
    // than stopping at the first.
    if (misfires.length) console.error("MISFIRES:\n  " + misfires.join("\n  "));
    if (missed.length) console.error(`MISSED (${missed.length}):\n  ` + missed.join("\n  "));

    expect(misfires, "a confident wrong answer is the one failure this design must not have").toEqual([]);
    expect(correct, `in-grammar recall regressed below the committed floor of ${RECALL_FLOOR}`).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });

  it("states the floor it is actually meeting, so raising it is a deliberate act", async () => {
    /*
     * A ratchet nobody tightens is a ratchet that rusts. This fails when recall exceeds the
     * floor by more than a point, forcing whoever improved the compiler to record the new
     * number here rather than banking silent headroom.
     */
    const c = await corpus();
    const inGrammar = BANK.filter(([, e]) => e !== null);
    const correct = inGrammar.filter(([q, e, direction]) => {
      const r = ask(q, c, isTest);
      return r.ok && r.plan.intent === e && (!direction || r.plan.direction === direction);
    }).length;
    expect(correct, `recall is ${correct}/${inGrammar.length}; raise RECALL_FLOOR to ${correct}`).toBeLessThanOrEqual(RECALL_FLOOR + 1);
  });
});
