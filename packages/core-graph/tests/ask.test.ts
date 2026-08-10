import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";
import { ask, compileAsk } from "../src/ask";
import { QueryEngine } from "../src/query";
import type { AskCorpus, AskPlan } from "../src/ask";
import type { ApiSurface } from "../src/api";

/**
 * Deterministic natural-language querying.
 *
 * WHAT THESE TESTS DEFEND
 *
 * Two properties, and they matter in opposite directions:
 *
 * 1. A question that IS supported compiles to the right plan. The dangerous confusion is
 *    inbound vs outbound - "what depends on X" and "what does X depend on" share every content
 *    word and mean opposite things, so a keyword bag answers one of them wrongly and looks
 *    confident doing it.
 *
 * 2. A question that is NOT supported is refused. A query surface that always produces
 *    something is worse than one that admits the gap, because the reader cannot tell the two
 *    apart. `unclassified` and `entity_not_found` are features, and are asserted as such.
 *
 * Every case is written against a real graph built by `buildSymbolGraph`, not a hand-authored
 * node list: the compiler is only as good as its ability to bind words to symbols that the
 * extractor actually produced.
 */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

const isTest = (file: string) => /\.test\.ts$/.test(file);

async function corpus(): Promise<AskCorpus> {
  const graph = await buildSymbolGraph(
    [
      f("db.ts", "export function connect() { return 1; }\n"),
      f("service.ts", "import { connect } from './db';\nexport function loadOrder(id: string) { return connect(); }\n"),
      f("controller.ts", "import { loadOrder } from './service';\nexport function getOrder(id: string) { return loadOrder(id); }\n"),
      f("app.test.ts", "import { getOrder } from './controller';\nit('works', () => { getOrder('1'); });\n"),
      f("lonely.ts", "export function neverCalled() { return 2; }\n"),
    ],
    new Map(),
  );
  return {
    graph,
    packageImporters: new Map([["redis", ["db.ts"]], ["express", ["controller.ts"]]]),
    fileImporters: new Map([
      ["db.ts", ["service.ts"]],
      ["service.ts", ["controller.ts"]],
      ["controller.ts", ["app.test.ts"]],
    ]),
  };
}

function planFor(question: string, c: AskCorpus): AskPlan {
  const p = compileAsk(question, c, new QueryEngine(c.graph));
  if ("ok" in p) throw new Error(`expected a plan, got failure: ${p.message}`);
  return p;
}

describe("ask: compiling questions to plans", () => {
  it("compiles the documented example to a dependency query, inbound and transitive", async () => {
    // The specification's own worked example:
    //   "What depends on Redis?" -> DEPENDENCY_QUERY + ENTITY(Redis) + INBOUND + TRANSITIVE
    const p = planFor("What depends on Redis?", await corpus());
    expect(p.intent).toBe("package_dependents");
    expect(p.entity).toMatchObject({ kind: "package", id: "redis" });
    expect(p.direction).toBe("inbound");
    expect(p.transitive).toBe(true);
  });

  it("separates inbound from outbound on sentences built from the same words", async () => {
    const c = await corpus();
    // The only difference is the auxiliary "does", which is exactly what English uses here.
    expect(planFor("who calls loadOrder", c).direction).toBe("inbound");
    expect(planFor("what does loadOrder use", c).direction).toBe("outbound");
    /*
     * The hard pair. Both sentences contain "depend" AND the phrase "depend(s) on", so the
     * only signal separating them is the auxiliary. Asserting just one of them passes even
     * with the rules deleted, because outbound is the fallback - mutation testing caught
     * exactly that, which is why both directions are pinned here on the same verb.
     */
    expect(planFor("what does loadOrder depend on", c).direction).toBe("outbound");
    expect(planFor("what depends on loadOrder", c).direction).toBe("inbound");
  });

  it("reads a change question as impact, not as a dependency lookup", async () => {
    const p = planFor("what breaks if I change loadOrder", await corpus());
    expect(p.intent).toBe("impact");
    expect(p.direction).toBe("inbound");
    expect(p.transitive).toBe(true);
  });

  it("honours an explicit direct/transitive modifier", async () => {
    const c = await corpus();
    expect(planFor("what does getOrder directly use", c).depth).toBe(1);
    expect(planFor("what does getOrder transitively use", c).transitive).toBe(true);
  });

  it("reports the operations it will run, so the answer can be checked", async () => {
    const p = planFor("what breaks if I change connect", await corpus());
    expect(p.operations.join(" ")).toContain("impactWithHops");
  });
});

describe("ask: executing against the graph", () => {
  it("answers impact with the real transitive caller set and flags the test on the path", async () => {
    const c = await corpus();
    const r = ask("what breaks if I change connect", c, isTest);
    if (!r.ok) throw new Error(r.message);
    const names = r.rows.map((x) => x.label);
    expect(names).toContain("loadOrder");
    expect(names).toContain("getOrder");
    // Every row carries the location that proves it.
    for (const row of r.rows) expect(row.file).not.toBe("");
    expect(r.headline).toMatch(/test/i);
  });

  it("answers the Redis question with the file that imports it and the files that reach it", async () => {
    const r = ask("what depends on redis", await corpus(), isTest);
    if (!r.ok) throw new Error(r.message);
    const direct = r.rows.filter((x) => x.hops === 1).map((x) => x.label);
    const indirect = r.rows.filter((x) => x.hops === 2).map((x) => x.label);
    expect(direct).toEqual(["db.ts"]);
    // db.ts <- service.ts <- controller.ts <- app.test.ts, all reached transitively.
    expect(indirect).toEqual(["app.test.ts", "controller.ts", "service.ts"]);
  });

  it("does not invent dependents for a package nothing imports", async () => {
    const c = await corpus();
    const r = ask("what depends on leftpad", { ...c, packageImporters: new Map([["leftpad", []]]) }, isTest);
    if (!r.ok) throw new Error(r.message);
    expect(r.rows).toHaveLength(0);
    expect(r.headline).toMatch(/nothing here uses it/i);
  });

  it("finds dead code and says why the answer is not a licence to delete", async () => {
    const r = ask("what is dead code", await corpus(), isTest);
    if (!r.ok) throw new Error(r.message);
    expect(r.rows.map((x) => x.label)).toContain("neverCalled");
    expect(r.headline).toMatch(/dynamic dispatch/i);
  });

  it("reports an empty result as a finding rather than as silence", async () => {
    const c = await corpus();
    const r = ask("what breaks if I change neverCalled", c, isTest);
    if (!r.ok) throw new Error(r.message);
    expect(r.rows).toHaveLength(0);
    expect(r.headline).toMatch(/breaks no other symbol/i);
  });
});

describe("ask: API and data flow", () => {
  const surface: ApiSurface = {
    endpoints: [
      { id: "POST /orders", method: "POST", routePath: "/orders", file: "routes.ts", line: 4, framework: "express", handlerSymbolId: "h", pathIsDynamic: false, authenticated: false, authEvidence: null },
      { id: "GET /health", method: "GET", routePath: "/health", file: "routes.ts", line: 9, framework: "express", handlerSymbolId: "h2", pathIsDynamic: false, authenticated: true, authEvidence: "requireAuth" },
    ],
    flows: [
      { endpointId: "POST /orders", hops: [{ symbolId: "h", name: "createOrder", file: "routes.ts", line: 4 }, { symbolId: "s", name: "chargeCard", file: "pay.ts", line: 8 }], sink: { kind: "network", symbolId: "s", evidence: "fetch(stripe)" } },
    ],
    truncated: false,
  };

  it("explains an endpoint as the chain the graph resolved, ending at a typed sink", async () => {
    const c = { ...(await corpus()), api: surface };
    const r = ask("explain POST /orders", c, isTest);
    if (!r.ok) throw new Error(r.message);
    expect(r.chains?.[0]?.steps).toEqual(["POST /orders", "createOrder", "chargeCard"]);
    expect(r.chains?.[0]?.sink).toMatch(/network/);
    expect(r.headline).toContain("routes.ts:4");
  });

  it("lists unguarded endpoints as triage and excludes the ones it could not determine", async () => {
    const c = { ...(await corpus()), api: surface };
    const r = ask("which endpoints are unauthenticated", c, isTest);
    if (!r.ok) throw new Error(r.message);
    expect(r.rows.map((x) => x.label)).toEqual(["POST /orders"]);
    expect(r.headline).toMatch(/triage list, not a verdict/i);
  });

  it("says the surface was never analysed rather than answering nothing", async () => {
    const r = ask("what endpoints exist", await corpus(), isTest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_analysed");
    expect(r.message).toMatch(/re-index/i);
  });
});

describe("ask: refusing what it cannot answer", () => {
  it("refuses an unclassifiable question and offers the forms that work", async () => {
    const r = ask("should we rewrite this in rust", await corpus(), isTest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unclassified");
    expect(r.examples.length).toBeGreaterThan(3);
  });

  it("refuses a known intent about an unknown entity, and suggests without substituting", async () => {
    const r = ask("what breaks if I change loadOrderz", await corpus(), isTest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("entity_not_found");
    // It found the near miss but did NOT answer as though the reader had typed it.
    expect(r.didYouMean).toContain("loadOrder");
  });

  /**
   * Binding a name to a thing, and refusing to guess when it should not.
   *
   * Each of these isolates ONE rule. The archived-directory exclusion alone happened to cover
   * the original bug report, which hid the fact that the other three rules were untested -
   * mutation testing caught that, so they get their own fixtures here.
   */
  async function named(files: ReadonlyArray<[string, string]>): Promise<AskCorpus> {
    return { graph: await buildSymbolGraph(files.map(([rel, text]) => f(rel, text)), new Map()) };
  }

  it("will not bind an ordinary word to a local symbol that merely happens to share it", async () => {
    /*
     * `run` exists, in a perfectly normal file, and is still not what "how do I run the tests"
     * is about. Only an EXPORTED symbol is deliberate enough surface to answer for a word this
     * common. The question does not dead-end — it degrades to a ranked search — but it must
     * not come back as a CALLERS answer about a private local, which would look identical to
     * a real one.
     */
    const c = await named([["src/util.ts", "function run() { return 1; }\nexport function go() { return run(); }\n"]]);
    const r = ask("who calls run", c, isTest);
    expect(r.ok && r.plan.intent).not.toBe("dependencies_of");
  });

  it("binds the same ordinary word once it is exported", async () => {
    const c = await named([["src/util.ts", "export function run() { return 1; }\n"]]);
    const r = ask("who calls run", c, isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entity?.label).toBe("run");
  });

  it("prefers the exported, most-depended-upon candidate over an incidental namesake", async () => {
    const c = await named([
      ["src/private.ts", "function handler() { return 1; }\nexport function callsLocal() { return handler(); }\n"],
      ["src/api.ts", "export function handler() { return 2; }\n"],
      ["src/a.ts", "import { handler } from './api';\nexport function a() { return handler(); }\n"],
      ["src/b.ts", "import { handler } from './api';\nexport function b() { return handler(); }\n"],
    ]);
    const r = ask("who calls handler", c, isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The exported one in `api.ts`, not the file-local one that shares the name.
    expect(r.plan.entity?.id).toContain("src/api.ts");
  });

  it("returns candidates rather than choosing when two fit equally well", async () => {
    /*
     * Same name, same export status, same fan-in, different files. There is no principled
     * winner, so picking one silently would answer a question the reader never asked. This is
     * a distinct outcome from "not found": three of them exist.
     */
    const c = await named([
      ["src/one/index.ts", "export function parse() { return 1; }\n"],
      ["src/two/index.ts", "export function parse() { return 2; }\n"],
    ]);
    const r = ask("who calls parse", c, isTest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ambiguous");
    expect(r.didYouMean).toHaveLength(2);
    expect(r.didYouMean.join(" ")).toMatch(/src\/one\/index\.ts/);
    expect(r.didYouMean.join(" ")).toMatch(/src\/two\/index\.ts/);
  });

  it("binds a file by name, dot and extension intact", async () => {
    /*
     * `normalise` stripped every `.` before the tokeniser ran, so `store.ts` arrived as
     * `store ts` and the file branch - which compares against real paths, extensions and all -
     * could never match ANY file. No file entity had ever bound. Found while building the
     * plan controls, which needed to offer file as an entity kind and could not.
     */
    const c = await named([
      ["src/store.ts", "export function alpha() { return 1; }\nexport function beta() { return 2; }\n"],
    ]);
    for (const q of ["what does src/store.ts depend on", "who calls store.ts"]) {
      const r = ask(q, c, isTest);
      expect(r.ok, q).toBe(true);
      if (!r.ok) continue;
      expect(r.plan.entity).toMatchObject({ kind: "file", id: "src/store.ts" });
    }
  });

  it("still drops a sentence-final period", async () => {
    const c = await named([["src/store.ts", "export function alpha() { return 1; }\n"]]);
    const r = ask("who calls alpha.", c, isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entity?.label).toBe("alpha");
  });

  it("is deterministic: the same question yields the same plan and the same rows", async () => {
    const c = await corpus();
    const a = ask("what breaks if I change connect", c, isTest);
    const b = ask("what breaks if I change connect", c, isTest);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is insensitive to casing, punctuation and filler words", async () => {
    const c = await corpus();
    const a = ask("what breaks if I change connect", c, isTest);
    const b = ask("Please show me: WHAT BREAKS if I change   connect???", c, isTest);
    if (!a.ok || !b.ok) throw new Error("both should classify");
    expect(b.plan.intent).toBe(a.plan.intent);
    expect(b.rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id));
  });
});

/**
 * The search floor.
 *
 * Measured against thirty-five questions written without reading the cue table: **five
 * answered, thirty refused**. The classifier was not WRONG on those thirty, it simply could
 * not parse them - which is the shape of a closed grammar, not a bug more cues would fix. A
 * surface that refuses six times in seven trains people to stop typing, so an unparseable
 * question now degrades to a ranked lookup instead of a dead end. Same corpus after: 33/35.
 */
describe("ask: degrading instead of refusing", () => {
  async function repo(): Promise<AskCorpus> {
    const graph = await buildSymbolGraph(
      [
        f("src/auth/session.ts", "/** Verify a signed session cookie. */\nexport function verifySession(token: string) { return token.length > 0; }\n"),
        /*
         * Tagged `auth` by its DOC, not its name: the extractor's rule matches `jwt`. This is
         * the case name matching cannot reach, and the only one that proves the tag index is
         * doing work.
         */
        f("src/gate.ts", "/** Rejects a request whose jwt is missing. */\nexport function gate(req: string) { return req; }\n"),
        /*
         * A weak match and nothing more: `auth` appears in its PATH, so it scores as a
         * path hit and must be dropped once something matched strongly.
         */
        f("src/authless/notes.ts", "export function notes() { return 2; }\n"),
        f("src/store.ts", "export function saveRecord(id: string) { return id; }\n"),
        f("src/util.ts", "export function unrelated() { return 1; }\n"),
      ],
      new Map(),
    );
    return { graph, packageImporters: new Map([["express", ["src/store.ts"]]]) };
  }
  it("answers an unparseable question with ranked matches rather than a dead end", async () => {
    const r = ask("what should I look at for sessions", await repo(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Relevance, not a fixed order: `session` resolves to the `auth` topic and both tagged
    // symbols are equally good answers, so pinning first place would test the tie-break.
    expect(r.rows.map((x) => x.label)).toContain("verifySession");
    expect(r.rows.map((x) => x.label)).not.toContain("unrelated");
  });

  it("says on the receipt that it did not understand, so the rows are not mistaken for a graph answer", async () => {
    const r = ask("what should I look at for sessions", await repo(), isTest);
    if (!r.ok) return;
    // The honesty the fallback has to preserve: degrading is fine, pretending is not.
    expect(r.plan.intent).toBe("search");
    expect(r.headline).toMatch(/not a question this graph can answer precisely/i);
  });

  it("resolves a topic word to the tag the extractor used", async () => {
    /*
     * "authentication" is not a symbol name and never will be. `gate` is the case that proves
     * the tag index is doing the work: its NAME, PATH and signature contain nothing like
     * "auth" — only its doc comment mentions a jwt, which is what the extractor's rule
     * matched. Name-based search cannot reach it by any spelling of the question.
     */
    const r = ask("where is authentication handled", await repo(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const labels = r.rows.map((x) => x.label);
    expect(labels).toContain("gate");
    expect(labels).toContain("verifySession");
  });

  it("never turns an unparseable question into a precise graph answer", async () => {
    // The one thing degrading must not do. A confident `impact` answer to "who wrote this"
    // is indistinguishable from a real one, which is the failure mode the whole design avoids.
    for (const q of ["who wrote this code", "what should I read first", "is this code secure"]) {
      const r = ask(q, await repo(), isTest);
      if (r.ok) expect(r.plan.intent, q).toBe("search");
    }
  });

  it("still answers precisely when the grammar does parse the question", async () => {
    // The floor must not swallow the ceiling: a question the compiler understands still gets
    // the graph answer, not a search.
    const r = ask("who calls verifySession", await repo(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.intent).toBe("dependencies_of");
    expect(r.plan.direction).toBe("inbound");
  });

  it("drops weak matches once something matched strongly", async () => {
    /*
     * `notes` matches only because `auth` appears in its PATH (`src/authless/`), while `gate`
     * and `verifySession` carry the tag itself. A hundred rows ordered by an invisible score
     * is the same as no answer, so once something scores strongly the merely-adjacent go.
     */
    const r = ask("where is authentication handled", await repo(), isTest);
    if (!r.ok) return;
    expect(r.rows.length).toBeLessThanOrEqual(25);
    expect(r.rows.map((x) => x.label)).not.toContain("notes");
    expect(r.rows.map((x) => x.label)).not.toContain("unrelated");
  });
});

/**
 * Questions about PEOPLE and about the external surface.
 *
 * These three intents exist because the product already had the data and Ask could not reach
 * it: the Ownership page rendered authors, bus factors and staleness while "who owns this
 * file" fell through to a ranked keyword search. The gap was not analysis, it was wiring, and
 * these tests are the wiring's contract.
 *
 * The sharp edge throughout is the difference between "the analysis says nobody" and "there is
 * no analysis". An empty owner list and an un-analysed repository look identical in a UI and
 * mean opposite things, so `not_analysed` is asserted as hard as the answers are.
 */
describe("ask: ownership, staleness and packages", () => {
  const OWNERSHIP = {
    /*
     * Deliberately NOT in commit order. A fixture that arrives pre-sorted cannot tell whether
     * the executor ranks or merely echoes - the two are indistinguishable until the input
     * disagrees with the expected output.
     */
    authors: [
      { name: "grace", commits: 12, filesTouched: 1 },
      { name: "ada", commits: 40, filesTouched: 3 },
    ],
    files: [
      // Healthy: two authors, recent. Must NOT appear in a staleness answer.
      { path: "service.ts", owners: [{ author: "ada", share: 0.6, commits: 6 }, { author: "grace", share: 0.4, commits: 4 }], busFactor: 2, staleDays: 3, orphaned: false },
      /*
       * The OLDEST file, and deliberately so: it is the decoy for an age-ordered ranking.
       * Someone who knows it is still here, which makes it the lesser risk despite the date.
       */
      { path: "db.ts", owners: [{ author: "ada", share: 1, commits: 9 }], busFactor: 1, staleDays: 900, orphaned: false },
      /*
       * ORPHANED and nothing else: touched recently, well inside the window, and its bus
       * factor is only meaningful when there are two authors. It is the row that isolates
       * orphaning - the criterion that stays a finding no matter how many people are around,
       * because "the person who knew this has gone" does not depend on the headcount.
       */
      { path: "lonely.ts", owners: [{ author: "hopper", share: 1, commits: 2 }], busFactor: 1, staleDays: 10, orphaned: true },
      /*
       * Bus-factor-one and NOTHING else: recent, and its author is still active. It is the
       * only file whose presence isolates the bus-factor criterion, because every other risky
       * row here would also be caught by age or by being orphaned.
       */
      { path: "controller.ts", owners: [{ author: "ada", share: 1, commits: 3 }], busFactor: 1, staleDays: 5, orphaned: false },
    ],
    symbols: [] as Array<{ symbolId: string; owners: Array<{ author: string; share: number }> }>,
    windowDays: 90,
  };

  async function owned(over: Partial<typeof OWNERSHIP> = {}): Promise<AskCorpus> {
    const base = await corpus();
    return { ...base, ownership: { ...OWNERSHIP, ...over } };
  }

  it("answers an unscoped ownership question with the authors, ranked by commits", async () => {
    const r = ask("who wrote this code", await owned(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.intent).toBe("ownership");
    expect(r.plan.entity).toBeNull();
    expect(r.rows.map((x) => x.label)).toEqual(["ada", "grace"]);
  });

  it("scopes to a file when the question names one", async () => {
    // The binding that could not happen at all until `normalise` stopped eating the dot.
    const r = ask("who owns db.ts", await owned(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entity?.kind).toBe("file");
    expect(r.rows.map((x) => x.label)).toEqual(["ada"]);
    // A bus factor of one is the finding, not a footnote: say it in the sentence.
    expect(r.headline).toContain("bus factor of one");
  });

  it("states the share as a share of commits, not of the code", async () => {
    /*
     * The analyser counts COMMITS TOUCHING A FILE. It never attributed a line to an author, so
     * "60% of this file" would be a claim the data cannot support - and it is exactly what a
     * reader assumes when a percentage sits next to a filename.
     */
    const r = ask("who owns service.ts", await owned(), isTest);
    if (!r.ok) return;
    expect(r.rows[0]!.detail).toContain("60% of commits touching service.ts");
    expect(r.headline).not.toMatch(/% of (the )?(file|code|lines)/);
  });

  it.each([
    ["history has no row for the symbol at all", () => []],
    ["history has a row but attributed nothing to it", (id: string) => [{ symbolId: id, owners: [] }]],
  ])("falls back to the file's owners when %s", async (_name, build) => {
    /*
     * Symbol-level attribution intersects changed line ranges with a symbol's CURRENT span, so
     * it misses whenever code moved. Reporting "nobody owns this" there would be a false
     * negative on a review question - the file has owners, and they are the answer.
     *
     * Both shapes of miss are covered because they fail differently: an ABSENT row is caught
     * by a truthiness check, an EMPTY one is not, and a `sym ? ... : ...` that looks correct
     * returns "nobody owns this" for the second.
     */
    const base = await corpus();
    const connect = base.graph.symbols.find((s) => s.name === "connect")!;
    const r = ask("who owns connect", { ...base, ownership: { ...OWNERSHIP, symbols: build(connect.id) } }, isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entity?.kind).toBe("symbol");
    expect(r.rows.map((x) => x.label)).toEqual(["ada"]);
    expect(r.rows[0]!.detail).toContain("commits touching db.ts");
  });

  it("prefers symbol-level attribution when history did touch the symbol", async () => {
    const base = await corpus();
    const connect = base.graph.symbols.find((s) => s.name === "connect")!;
    const r = ask("who owns connect", { ...base, ownership: { ...OWNERSHIP, symbols: [{ symbolId: connect.id, owners: [{ author: "grace", share: 0.9 }] }] } }, isTest);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.label)).toEqual(["grace"]);
    expect(r.rows[0]!.detail).toContain("commits intersecting connect");
  });

  it("reports a missing analysis rather than answering that nobody owns anything", async () => {
    // The distinction the whole surface turns on. An un-analysed repo must not read as an
    // unowned one, and must not quietly degrade to a keyword search either.
    const r0 = ask("who owns db.ts", await corpus(), isTest);
    expect(r0.ok).toBe(false);
    if (r0.ok) return;
    expect(r0.reason).toBe("not_analysed");
  });

  it("excludes paths that are no longer in the analysed tree", async () => {
    /*
     * `ownership.files` comes from COMMIT HISTORY, which holds every path that ever existed.
     * Measured on this repository before the filter: 2,639 entries against 350 analysed files,
     * so most rows named something the reader could not open. A real regression, found by
     * running the question rather than by reading the code.
     */
    const deleted = { path: "removed/old.ts", owners: [{ author: "hopper", share: 1, commits: 1 }], busFactor: 1, staleDays: 999, orphaned: true };
    const r = ask("which files are stale", await owned({ files: [...OWNERSHIP.files, deleted] }), isTest);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.label)).not.toContain("removed/old.ts");
  });

  it("does not call every file risky in a single-author repository", async () => {
    /*
     * A bus factor of one means nothing when there is only one author - it describes the whole
     * codebase by definition. Left unguarded this reported 2,639 files as at risk, which is a
     * warning a reader can only learn to ignore.
     *
     * Suppressed, not silently dropped: the answer has to distinguish "nothing is stale" from
     * "this criterion could not tell you anything".
     */
    const solo = await owned({ authors: [{ name: "ada", commits: 40, filesTouched: 3 }] });
    const r = ask("which files are stale", solo, isTest);
    if (!r.ok) return;
    /*
     * `controller.ts` is the discriminator: bus-factor-one and nothing else. It is a finding
     * with two authors and must not be one with a single author. `lonely.ts` stays because
     * ORPHANED is still meaningful when there is one author, and `db.ts` stays because it is
     * genuinely old - neither criterion depends on how many people are around.
     */
    expect(r.rows.map((x) => x.label)).toEqual(["lonely.ts", "db.ts"]);
    expect(r.headline).toContain("Only one author has committed here");
  });

  it("ranks staleness by risk, not by age", async () => {
    /*
     * Old is not the same as dangerous. `service.ts` is recent and shared and must be absent;
     * `lonely.ts` is orphaned and must come first even though `db.ts` is far older, and
     * `controller.ts` comes last because bus-factor-one on a recent file is the mildest of the
     * three findings.
     */
    const r = ask("which files are stale", await owned(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.label)).toEqual(["lonely.ts", "db.ts", "controller.ts"]);
    expect(r.rows[0]!.detail).toContain("orphaned");
    expect(r.rows[1]!.detail).toContain("single author (ada)");
  });

  it("says so when every file is healthy instead of padding the list", async () => {
    const r = ask("what is under-maintained", await owned({ files: [OWNERSHIP.files[0]!] }), isTest);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(0);
    expect(r.headline).toContain("No analysed file is orphaned");
  });

  it("lists external packages by how many files import them", async () => {
    const r = ask("what packages does this repository use", await corpus(), isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.intent).toBe("packages");
    expect(r.rows.map((x) => x.label)).toEqual(["express", "redis"]);
  });

  it("keeps a declared package nothing imports, and labels it", async () => {
    // The most actionable row in the list; filtering it out would hide the answer to "can we
    // drop this".
    const base = await corpus();
    const r = ask("list the libraries", { ...base, packageImporters: new Map([...base.packageImporters!, ["leftpad", []]]) }, isTest);
    if (!r.ok) return;
    const leftpad = r.rows.find((x) => x.label === "leftpad");
    expect(leftpad?.detail).toBe("declared, imported by nothing here");
  });

  it("answers a question about unused LIBRARIES with libraries, not with dead symbols", async () => {
    /*
     * A real wrong answer, found by running the question rather than by reading the code.
     *
     * "unused" folds to `dead` and "libraries" folds to `package`, and the `dead_code` rule
     * sat higher in the table - so this compiled to a dead-code walk and returned a hundred
     * dead SYMBOLS under a confident headline. The reader asked about dependencies and got
     * something else entirely, with nothing on screen to reveal the substitution.
     */
    const base = await corpus();
    const c = { ...base, packageImporters: new Map([...base.packageImporters!, ["leftpad", []], ["moment", []]]) };
    const r = ask("which libraries are unused", c, isTest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.intent).toBe("unused_packages");
    expect(r.rows.map((x) => x.label)).toEqual(["leftpad", "moment"]);
  });

  it("narrows to the unused ones rather than burying them in the full list", async () => {
    // Sorting the fourteen unused packages to the bottom of fifty-three is a quieter version
    // of the same failure: the question was narrower than the answer.
    const base = await corpus();
    const c = { ...base, packageImporters: new Map([...base.packageImporters!, ["leftpad", []]]) };
    const r = ask("which packages are unused", c, isTest);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.label).toBe("leftpad");
    // Never a bare "delete these": a bundler or a config file can need a package no source
    // file imports, and the answer has no way to see that.
    expect(r.headline).toContain("confirm before removing");
  });

  it("says every package is used rather than returning nothing at all", async () => {
    const r = ask("which packages are unused", await corpus(), isTest);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(0);
    expect(r.headline).toContain("imported by at least one file");
  });

  it.each([
    ["what external dependencies are there", "packages"],
    ["which files have a bus factor problem", "stale"],
    ["what code is abandoned", "stale"],
  ] as const)("routes %s to %s", async (q, intent) => {
    // Phrasings measured against a real index that fell through to ranked search. None of them
    // says "package" or "stale", and all three are how the question is normally typed.
    expect(planFor(q, await owned()).intent).toBe(intent);
  });

  it("still answers the question about ONE package as a dependents walk", async () => {
    // The `packages` cue sits above `dependencies_of` and matches the word "package", so the
    // risk it introduces is stealing the question that names one. Direction settles it.
    const r = ask("what depends on the express package", await corpus(), isTest);
    if (!r.ok) return;
    expect(r.plan.intent).toBe("package_dependents");
    expect(r.plan.entity?.label).toBe("express");
  });

  it("does not let the ownership cue steal a call-graph question", async () => {
    // "who" belongs to both families. `wrote`/`own`/`review` are what separate them, and
    // `who calls X` must survive the new rule sitting above `dependencies_of`.
    const p = planFor("who calls loadOrder", await corpus());
    expect(p.intent).toBe("dependencies_of");
    expect(p.direction).toBe("inbound");
  });

  it("reads a review question as staffing rather than as impact", async () => {
    // "who should review this change" contains `change`, which is an `impact` cue. A reviewer
    // recommendation is not a blast radius, and the ordering of the cue table is what says so.
    const p = planFor("who should review changes to db.ts", await owned());
    expect(p.intent).toBe("ownership");
    expect(p.entity?.label).toBe("db.ts");
  });
});
