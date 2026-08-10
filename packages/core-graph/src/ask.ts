/**
 * Deterministic natural-language querying over the symbol graph.
 *
 * WHAT THIS IS, AND WHAT IT REFUSES TO BE
 *
 * A question in English is normalised, tokenised, classified into ONE of a closed set of
 * intents, bound to an entity resolved against the graph, and compiled into a plan of
 * operations that already exist on `QueryEngine` and `ApiSurface`. The plan is executed and
 * returned ALONGSIDE the answer, so the reader can see exactly which deterministic query ran.
 *
 * There is no model here, no embedding, and no similarity score standing in for understanding.
 * "What depends on Redis?" compiles to
 *
 *     DEPENDENCY_QUERY + ENTITY(redis, package) + INBOUND + TRANSITIVE
 *
 * and then runs that. The same question always compiles to the same plan and the same plan
 * always produces the same answer, which is the property a graph tool has to have and a
 * generative one cannot offer.
 *
 * WHY THE GRAMMAR IS CLOSED AND SAID OUT LOUD
 *
 * The failure mode of a natural-language surface is not misunderstanding a question, it is
 * ANSWERING one it did not understand. A confident wrong answer about who calls a function is
 * worse than no answer, because the reader has no way to tell. So classification either binds
 * a question to an intent it can execute or returns `unsupported` with the forms that do work.
 * `AskAnswer.plan` is not debug output; it is the receipt.
 *
 * LAYERING
 *
 * `core-graph` may only depend on `core-domain` (`.dependency-cruiser.cjs`), so this module
 * cannot see `VizGraph`, which is where external packages and file-to-file imports live. The
 * caller passes those in as plain maps in `AskCorpus`. That is the better boundary anyway: the
 * query compiler has no business knowing the shape of a rendering model.
 */

import type { ApiEndpoint, ApiSurface, DataFlowPath } from "./api";
import { QueryEngine } from "./query";
import type { CodeSymbol, SymbolGraph } from "./symbol";

/** The closed set of questions this compiler can answer. */
export type AskIntent =
  /** The floor: a ranked look across everything, for a question the grammar cannot parse. */
  | "search"
  | "symbol_search"
  | "impact"
  | "dependencies_of"
  | "callers"
  | "callees"
  | "package_dependents"
  | "packages"
  | "explain_flow"
  | "endpoints"
  | "unauthenticated"
  | "dead_code"
  | "cycles"
  | "hubs"
  | "ownership"
  | "stale"
  | "unused_packages"
  | "untested";

export type AskEntityKind = "symbol" | "file" | "package" | "endpoint";

export interface AskEntity {
  readonly kind: AskEntityKind;
  /** The graph key: a symbol id, a repo-relative file path, a package name, or an endpoint id. */
  readonly id: string;
  /** What the reader typed it as, for echoing back in the headline. */
  readonly label: string;
}

/**
 * The compiled query. Returned with every answer so the operation that ran is inspectable
 * rather than implied.
 */
export interface AskPlan {
  readonly intent: AskIntent;
  readonly entity: AskEntity | null;
  /** `inbound` = who reaches the entity. `outbound` = what the entity reaches. */
  readonly direction: "inbound" | "outbound" | "none";
  readonly transitive: boolean;
  readonly depth: number;
  /** The operations executed, in order, in the vocabulary of the query surface. */
  readonly operations: readonly string[];
}

/** One row of evidence. Every row carries the location that proves it. */
export interface AskRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly file: string;
  readonly line: number;
  /** Hop distance from the entity, when the intent walked a path. */
  readonly hops?: number;
}

export interface AskAnswer {
  readonly ok: true;
  readonly question: string;
  readonly plan: AskPlan;
  /** A sentence assembled from the facts below it. Never a claim the rows do not support. */
  readonly headline: string;
  readonly rows: readonly AskRow[];
  /** A step chain for `explain_flow`: endpoint -> handler -> ... -> sink. */
  readonly chains?: ReadonlyArray<{ title: string; steps: readonly string[]; sink: string | null }>;
  /** True when a cap was hit, so the reader knows the answer is a prefix of the truth. */
  readonly truncated: boolean;
}

export interface AskFailure {
  readonly ok: false;
  readonly question: string;
  readonly reason: "unclassified" | "entity_required" | "entity_not_found" | "ambiguous" | "not_analysed";
  readonly message: string;
  /** What the reader could type instead. Populated for every failure reason. */
  readonly examples: readonly string[];
  /**
   * For `entity_not_found`, the closest things that DO exist; for `ambiguous`, the candidates
   * that fit equally well. Never auto-substituted either way - the reader chooses.
   */
  readonly didYouMean: readonly string[];
}

export type AskResult = AskAnswer | AskFailure;

/**
 * Git ownership, in the shape the compiler needs rather than the shape the analyser produces.
 *
 * Declared structurally here for the SAME reason `packageImporters` is: `OwnershipReport` lives
 * in `@codegraph/analysis-model`, which this package may not import (`.dependency-cruiser.cjs`).
 * A structural subset costs one interface and keeps the boundary, and because it is a subset
 * the adapter passes the real report straight through with no mapping to drift.
 */
export interface AskOwnership {
  readonly authors: ReadonlyArray<{ readonly name: string; readonly commits: number; readonly filesTouched: number }>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly owners: ReadonlyArray<{ readonly author: string; readonly share: number; readonly commits: number }>;
    /** How many authors it takes to cover most of this file's history. 1 = a single point of knowledge. */
    readonly busFactor: number;
    readonly staleDays: number | null;
    /** Every owner is inactive in the window: nobody who knows this file is still around. */
    readonly orphaned: boolean;
  }>;
  readonly symbols: ReadonlyArray<{ readonly symbolId: string; readonly owners: ReadonlyArray<{ readonly author: string; readonly share: number }> }>;
  readonly windowDays: number;
}

/**
 * Everything the compiler is allowed to look at.
 *
 * `packageImporters` and `fileImporters` are supplied by the caller because they come from the
 * visualisation model, which this package may not import. Absent maps mean "not available",
 * which is answered as such rather than as an empty result.
 */
export interface AskCorpus {
  readonly graph: SymbolGraph;
  readonly api?: ApiSurface;
  /** External package name -> repo-relative files that import it. */
  readonly packageImporters?: ReadonlyMap<string, readonly string[]>;
  /** Repo-relative file -> files that import it. */
  readonly fileImporters?: ReadonlyMap<string, readonly string[]>;
  /** Absent when history was never analysed, which is reported rather than shown as empty. */
  readonly ownership?: AskOwnership;
}

const MAX_ROWS = 100;
/**
 * A search shows fewer rows than a graph answer, deliberately.
 *
 * Every row of a precise answer is equally real - all 50 callers ARE callers. A search's tail
 * is where its confidence has already run out, so showing more of it only dilutes the top.
 */
const SEARCH_ROWS = 25;
const DEFAULT_DEPTH = 4;

/**
 * Words carrying no discriminating power for intent. Removed before cue matching so that
 * "what are the circular dependencies" and "circular dependencies" classify identically.
 * Deliberately short: an over-eager stop list eats the very words that pick the intent
 * ("what", "who" and "which" are kept because they select direction downstream).
 *
 * `find` was here and had to come out: "find the function called packageOf" classified as a
 * CALL query, because dropping `find` left `call` as the only surviving cue. A word that
 * selects an intent is not a stop word, however conversational it looks.
 */
const STOP = new Set(["a", "an", "the", "is", "are", "was", "were", "do", "does", "did", "of", "in", "on", "to", "for", "any", "there", "me", "please", "show", "list", "tell", "get", "give"]);

/**
 * Question words that name a TOPIC the extractor already tags symbols with.
 *
 * The graph labels symbols `auth`, `db`, `http`, `crypto`, `io`, `ui`, `error`, `config`,
 * `test` — a hand-built topic index that no other part of the product reads. This is the
 * bridge from how a person says it to how the extractor spelled it, and it is what lets
 * "where is authentication handled" return the auth-tagged symbols instead of every function
 * whose name contains "handle".
 *
 * Deliberately a dictionary and not a similarity model: it is auditable, it is diffable, and a
 * wrong entry is a one-line fix. It also has to be separate from `SYNONYM`, which folds words
 * for INTENT matching — `auth` there means "the question mentions authentication", here it
 * means "look for things tagged auth", and conflating the two made the topic word get
 * discarded as cue vocabulary before the search ever saw it.
 */
const TOPIC_TAG = new Map<string, string>(Object.entries({
  auth: "auth", authentication: "auth", authorisation: "auth", authorization: "auth",
  login: "auth", signin: "auth", session: "auth", permission: "auth", credential: "auth",
  database: "db", db: "db", sql: "db", storage: "db", persistence: "db", query: "db",
  http: "http", request: "http", response: "http", api: "http", endpoint: "http", route: "http",
  crypto: "crypto", encryption: "crypto", hash: "crypto", secret: "crypto", token: "crypto",
  io: "io", filesystem: "io", file: "io", disk: "io",
  ui: "ui", component: "ui", render: "ui", view: "ui",
  error: "error", exception: "error", failure: "error",
  config: "config", configuration: "config", setting: "config", settings: "config", env: "config",
  test: "test", testing: "test", spec: "test",
}));
/**
 * Synonyms folded to one canonical term before cue matching.
 *
 * This is the whole "semantic" layer, and it is a dictionary on purpose: it is auditable, it is
 * diffable, and when it gets something wrong the fix is one line rather than a retrain.
 */
const SYNONYM = new Map<string, string>(Object.entries({
  uses: "use", using: "use", used: "use", usage: "use", usages: "use",
  calls: "call", calling: "call", called: "call", caller: "call", callers: "call",
  callee: "callee", callees: "callee",
  depends: "depend", depend: "depend", dependency: "depend", dependencies: "depend", dependent: "depend", dependents: "depend", depending: "depend", depended: "depend", relies: "depend", rely: "depend",
  imports: "import", importing: "import", imported: "import",
  breaks: "break", broken: "break", breaking: "break",
  changes: "change", changed: "change", changing: "change", modify: "change", modifying: "change", modified: "change", edit: "change", editing: "change", rename: "change", renaming: "change", touch: "change", touching: "change",
  affects: "affect", affected: "affect", affecting: "affect", impacts: "impact", impacted: "impact",
  // The product's own word for this, printed on the Impact page. It was missing, so the tool
  // could not answer a question phrased in its own vocabulary.
  blast: "impact", radius: "impact",
  endpoints: "endpoint", routes: "endpoint", route: "endpoint", apis: "api", url: "endpoint", urls: "endpoint",
  unauthenticated: "unauth", unauthorised: "unauth", unauthorized: "unauth", unprotected: "unauth", unguarded: "unauth", public: "unauth",
  guarded: "auth", authenticated: "auth", authentication: "auth", auth: "auth", protected: "auth", authorisation: "auth", authorization: "auth",
  circular: "cycle", cycles: "cycle", cyclic: "cycle", loop: "cycle", loops: "cycle",
  dead: "dead", unused: "dead", unreachable: "dead", orphaned: "dead",
  untested: "untested", tests: "test", tested: "test", testing: "test", coverage: "test",
  hub: "hub", hubs: "hub", hotspot: "hub", hotspots: "hub", central: "hub", important: "hub", critical: "hub",
  packages: "package", package: "package", library: "package", libraries: "package", dep: "package", deps: "package", module: "package", modules: "package",
  "third-party": "package", thirdparty: "package", vendor: "package", vendored: "package",
  /*
   * Ownership vocabulary, split three ways because the three questions want different answers:
   * "who WROTE it" is history, "who OWNS it" is the current share, and "who should REVIEW it"
   * is a recommendation derived from both. They fold to one intent and the executor separates
   * them, but keeping the words distinct leaves that door open.
   */
  wrote: "wrote", write: "wrote", writes: "wrote", written: "wrote", author: "wrote", authors: "wrote", authored: "wrote", contributor: "wrote", contributors: "wrote",
  own: "own", owns: "own", owner: "own", owners: "own", owned: "own", ownership: "own", maintainer: "own", maintainers: "own", maintains: "own", maintain: "own", knows: "own", familiar: "own", familiarity: "own", expert: "own",
  review: "review", reviewer: "review", reviewers: "review", reviews: "review",
  /*
   * `orphaned` is deliberately NOT here - it already folds to `dead`, which is a claim about
   * the call graph rather than about history. Two different absences: nothing calls it, versus
   * nobody maintains it. Conflating them would answer a staffing question with a dead-code list.
   */
  stale: "stale", stalest: "stale", abandoned: "stale", neglected: "stale", untouched: "stale", rotting: "stale", unmaintained: "stale", undermaintained: "stale", "under-maintained": "stale", "bus-factor": "stale", busfactor: "stale",
  explain: "explain", how: "how", works: "work", work: "work", flow: "flow", flows: "flow", happens: "happen", happen: "happen",
  where: "where", defined: "define", define: "define", definition: "define", declaration: "define", declared: "define",
  find: "find", locate: "find", search: "find",
  most: "most", top: "most", biggest: "most", largest: "most",
  transitive: "transitive", transitively: "transitive", indirect: "transitive", indirectly: "transitive", deep: "transitive", all: "transitive",
  direct: "direct", directly: "direct", immediate: "direct",
}));

/**
 * Words that flip the meaning of the cue they govern.
 *
 * WHY THIS EXISTS. "which routes have no auth" scored 36 endpoints and reported them as the
 * answer. `auth` matched the auth cue, `routes` matched the endpoint cue, and `no` was thrown
 * away as a stop word - so a question about MISSING guards was answered with a list of
 * everything. On a security question a confident wrong answer is the worst possible output,
 * and negation is the cheapest thing in the sentence to notice.
 *
 * Polarity is global to the question rather than scoped to one clause. That is a real
 * limitation and it is the right trade here: the supported grammar has no conjunctions, so
 * there is no second clause for a negation to belong to.
 */
const NEGATORS = new Set(["no", "not", "never", "without", "missing", "lacking", "lacks", "lack", "none", "nothing", "un", "isnt", "arent", "doesnt", "dont", "cannot", "cant"]);

/**
 * Lowercase, drop punctuation that never disambiguates, collapse whitespace.
 *
 * THE DOT IS NOT PUNCTUATION HERE. This stripped `.` unconditionally, so `store.ts` arrived at
 * the tokeniser as `store ts` and the file branch of `resolveEntity` - which compares against
 * real paths, extensions and all - could never match ANY file. The tokeniser's comment
 * promising that code-shaped tokens survive was defeated one step upstream of it, and no file
 * entity had ever bound. A sentence-final period still goes; a dot between two characters is
 * part of a name.
 */
function normalise(q: string): string {
  return q
    .toLowerCase()
    .replace(/[?!,;]+/g, " ")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split into terms, preserving the two things that must survive tokenising: a quoted phrase,
 * and anything that looks like code (`a.b`, `a/b.ts`, `a_b`, `GET /x`). Those are entity
 * candidates and breaking them apart would destroy the only precise signal in the sentence.
 */
function tokenise(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`|([a-z0-9_$./\\-]+)/gi)) {
    const t = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (t) out.push(t);
  }
  return out;
}

/** Canonical content terms, plus whether the question was negated. */
function canonical(tokens: readonly string[]): { terms: string[]; negated: boolean } {
  let negated = false;
  const terms: string[] = [];
  for (const t of tokens) {
    if (NEGATORS.has(t)) { negated = true; continue; }
    const c = SYNONYM.get(t) ?? t;
    if (!STOP.has(c)) terms.push(c);
  }
  return { terms, negated };
}

/**
 * Intent cues, ordered most specific first.
 *
 * Order is the whole disambiguation strategy and it is load-bearing: "what breaks if I change
 * X" contains both `break` and `change`, and "what does X depend on" contains `depend` exactly
 * as "what depends on X" does. A flat keyword bag cannot separate those, so the specific
 * multi-cue rules are tested before the single-cue ones, and direction is decided separately
 * from intent below.
 *
 * `negated` means the rule fires ONLY on a negated question, and it is what separates "which
 * endpoints exist" from "which endpoints have no auth" - two questions built from the same
 * content words that want opposite answers. Negated rules sit above their positive twins.
 *
 * `entity` is three-valued and used to be a boolean, which could not express the shape
 * ownership actually has: "who owns src/store.ts" and "who wrote this code" are the same
 * question at two scopes, and a required binding would refuse the second while `none` would
 * ignore the path in the first. `optional` resolves when something binds and answers globally
 * when nothing does.
 */
const CUES: ReadonlyArray<{
  intent: AskIntent;
  all?: readonly string[];
  any?: readonly string[];
  /** Require the question to be negated (true) or non-negated (false). Absent = either. */
  negated?: boolean;
  entity: "required" | "optional" | "none";
}> = [
  { intent: "cycles", all: ["cycle"], entity: "none" },
  /*
   * Above `impact`, because "who should review this change" is a staffing question that
   * happens to contain the word "change", and the impact rule below would otherwise take it.
   */
  { intent: "ownership", any: ["wrote", "own", "review"], entity: "optional" },
  { intent: "stale", any: ["stale"], entity: "none" },
  // "bus factor" arrives as two tokens when it is typed as two words; the hyphenated and
  // closed-up spellings fold in `SYNONYM`.
  { intent: "stale", all: ["bus", "factor"], entity: "none" },
  /*
   * MUST outrank `dead_code`, which is the bug this rule exists for. "which libraries are
   * unused" folds to `package` + `dead`, and `dead_code` took it - answering a question about
   * libraries with a hundred dead SYMBOLS. Confidently wrong, and the reader had no way to
   * see it: the rows looked like an answer.
   */
  { intent: "unused_packages", all: ["package", "dead"], entity: "none" },
  { intent: "impact", all: ["break"], entity: "required" },
  { intent: "impact", all: ["impact"], entity: "required" },
  { intent: "impact", all: ["affect"], entity: "required" },
  // "if I rename X what else has to change" - a change question with no other cue.
  { intent: "impact", all: ["change"], entity: "required" },
  { intent: "unauthenticated", all: ["unauth"], entity: "none" },
  // "which routes have no auth", "endpoints without authentication".
  { intent: "unauthenticated", all: ["auth"], negated: true, entity: "none" },
  { intent: "untested", any: ["untested"], entity: "none" },
  // "what has no tests", "functions without coverage".
  { intent: "untested", all: ["test"], negated: true, entity: "none" },
  { intent: "dead_code", all: ["dead"], entity: "none" },
  // A superlative with a dependency word is asking for the ranking, not about one symbol:
  // "what is most depended upon" has no entity to bind and is not a dependency lookup.
  { intent: "hubs", all: ["most", "depend"], entity: "none" },
  { intent: "hubs", all: ["most", "use"], entity: "none" },
  { intent: "hubs", any: ["hub"], entity: "none" },
  // Naming-a-thing beats the verb inside the name: "find the function CALLED packageOf".
  { intent: "symbol_search", any: ["find", "define"], entity: "required" },
  { intent: "explain_flow", any: ["explain", "how", "flow", "happen", "work"], entity: "required" },
  { intent: "endpoints", any: ["endpoint", "api"], entity: "none" },
  { intent: "untested", all: ["test"], entity: "none" },
  /*
   * Above `dependencies_of` because "what packages does this use" has no entity to bind and
   * would otherwise refuse. When a package DOES bind, `compileAsk` refines this back to
   * `package_dependents` - the same refinement `dependencies_of` already gets, for the same
   * reason: naming an external package changes which walk answers the question.
   */
  { intent: "packages", all: ["package"], entity: "optional" },
  // "what external dependencies are there" never says "package": `dependencies` folds to
  // `depend`, so without this the sentence reached `dependencies_of` with nothing to bind.
  { intent: "packages", all: ["external", "depend"], entity: "none" },
  { intent: "dependencies_of", any: ["depend", "use", "import", "call", "callee"], entity: "required" },
  { intent: "symbol_search", any: ["where"], entity: "required" },
];

/**
 * Inbound or outbound.
 *
 * English marks this with word order, not vocabulary: "what depends on X" is inbound, "what
 * does X depend on" is outbound, and both are built from the same content words. The
 * discriminator is the auxiliary "does", which is what turns the sentence around.
 *
 * Outbound is the fallback, so only the two INBOUND rules carry weight; an outbound rule that
 * merely reaches the same answer as the fallback is dead code, and one was deleted here after
 * mutation testing showed removing it changed no result. What remains is the narrow "does +
 * verb" case, kept because it must beat the `depends on` rule below it for "what does X depend
 * on", where both patterns are present in the same sentence.
 */
function directionOf(raw: string, intent: AskIntent): "inbound" | "outbound" | "none" {
  if (intent === "impact" || intent === "package_dependents") return "inbound";
  if (intent === "dependencies_of") {
    if (/\bdoes\b[^.]*\b(use|call|depend|import)/.test(raw)) return "outbound";
    /*
     * The PASSIVE forms, which are the ones people actually type when they want callers:
     * "usages of X", "where is X used", "who is X called by". All of these ask what reaches
     * the entity, and all of them fell through to the outbound fallback - so the tool
     * confidently answered what X calls when the reader asked what calls X. Same class of
     * error as ignoring a negation: the opposite question, answered without hesitation.
     */
    if (/\busages?\s+of\b/.test(raw)) return "inbound";
    if (/\b(is|are)\b[^.]*\b(used|called|imported|referenced)\b/.test(raw)) return "inbound";
    if (/\b(used|called|imported|referenced)\s+by\b/.test(raw)) return "inbound";
    if (/\b(depends?|relies|rely)\s+(up)?on\b/.test(raw)) return "inbound";
    if (/\b(who|what|which)\s+(calls?|uses?|imports?)\b/.test(raw)) return "inbound";
    return "outbound";
  }
  return "none";
}

/** "transitive"/"indirect"/"all" widen the walk; "direct"/"immediate" pin it to one hop. */
function transitivityOf(canon: readonly string[], intent: AskIntent): { transitive: boolean; depth: number } {
  if (canon.includes("direct")) return { transitive: false, depth: 1 };
  if (intent === "impact" || intent === "package_dependents") return { transitive: true, depth: DEFAULT_DEPTH };
  if (canon.includes("transitive")) return { transitive: true, depth: DEFAULT_DEPTH };
  return { transitive: false, depth: 1 };
}

/**
 * The outcome of binding words to a thing in the graph.
 *
 * `ambiguous` is separate from `didYouMean` on purpose. A near miss is "you may have meant
 * this, confirm it"; an ambiguity is "several things fit equally and I will not pick one for
 * you". Collapsing them would let a coin flip look like a suggestion.
 */
interface EntityBinding {
  readonly entity: AskEntity | null;
  readonly didYouMean?: readonly string[];
  readonly ambiguous?: readonly string[];
}

/**
 * Trees whose symbols should never win an entity binding.
 *
 * Archived designs, vendored copies and build output all contain real, parseable symbols that
 * nobody asking a question about "this repository" means. They stay in the graph - they are
 * genuinely there, and dead-code analysis should still see them - but they lose every tie.
 */
function isBackwater(file: string): boolean {
  return /(^|\/)(archive|archived|legacy|vendor|vendored|third[_-]?party|node_modules|dist|build|out|\.next|coverage|fixtures?|__fixtures__|examples?|samples?)\//i.test(file);
}

/**
 * Words too ordinary to name a thing on their own.
 *
 * "how do I run the tests" is not a question about a function named `run`, even though one
 * exists. These bind only when the match is an EXPORTED symbol, which is the cheapest
 * available evidence that the name is a deliberate part of the repository's surface rather
 * than an incidental local.
 */
const WEAK_ENTITY_WORDS = new Set([
  "run", "test", "tests", "main", "index", "get", "set", "add", "remove", "start", "stop",
  "init", "setup", "build", "make", "create", "update", "delete", "handle", "process", "parse",
  "load", "save", "read", "write", "open", "close", "check", "value", "data", "item", "name",
  "type", "key", "id", "code", "file", "files", "line", "lines", "error", "result", "config",
]);
/**
 * Bind the leftover words to something that exists.
 *
 * Resolution order is by precision, not by convenience: an exact endpoint, then an exact
 * package (external dependencies are named exactly or not at all), then a file path, then a
 * symbol via the graph's own ranked search. Nothing is fuzzy-matched into existence - a near
 * miss becomes `didYouMean`, which the reader confirms, rather than a silent substitution that
 * answers a question they did not ask.
 */
function resolveEntity(raw: string, tokens: readonly string[], corpus: AskCorpus, qe: QueryEngine): EntityBinding {
  const endpoint = matchEndpoint(raw, corpus.api);
  if (endpoint) return { entity: { kind: "endpoint", id: endpoint.id, label: `${endpoint.method} ${endpoint.routePath}` }, didYouMean: [] };

  const content = tokens.filter((t) => !STOP.has(t) && !SYNONYM.has(t) && !RESERVED.has(t));

  /*
   * Exact names beat scoped suffixes, across the WHOLE set, before any suffix is considered.
   * Matching in one pass let map order decide: "what depends on react" bound to
   * `@monaco-editor/react` on a repository that also declares `react`, and the answer was
   * about a package the reader had not named.
   */
  if (corpus.packageImporters) {
    const names = [...corpus.packageImporters.keys()];
    for (const t of content) {
      const exact = names.find((n) => n.toLowerCase() === t);
      if (exact) return { entity: { kind: "package", id: exact, label: exact }, didYouMean: [] };
    }
    for (const t of content) {
      // `@scope/name` answered by its bare name, but only when nothing is called that exactly.
      const scoped = names.filter((n) => n.toLowerCase().endsWith(`/${t}`)).sort();
      if (scoped.length === 1) return { entity: { kind: "package", id: scoped[0]!, label: scoped[0]! }, didYouMean: [] };
      // Two packages end in the same name, so the question is genuinely ambiguous: offer both
      // rather than picking. Falls through to the not-found path, which carries `didYouMean`.
      if (scoped.length > 1) return { entity: null, didYouMean: scoped.slice(0, 5) };
    }
  }

  const files = new Set(corpus.graph.symbols.map((s) => s.file));
  for (const t of content) {
    if (!t.includes("/") && !t.includes(".")) continue;
    for (const f of files) {
      if (f.toLowerCase() === t || f.toLowerCase().endsWith(`/${t}`)) {
        return { entity: { kind: "file", id: f, label: f }, didYouMean: [] };
      }
    }
  }

  /*
   * SYMBOLS, RANKED - and only when the match is worth acting on.
   *
   * This used to take the first exact name match `QueryEngine.search` happened to return.
   * Measured: "how do I run the tests" bound to a function `run` in
   * `docs/archive/legacy-design/.../test_extractors.py` and answered a call-graph question
   * about it. Two things were wrong and both are fixed here.
   *
   * 1. NOT EVERY MATCH DESERVES AN ANSWER. A one-word common noun that happens to name a
   *    symbol in an archived directory is not what the reader meant. Candidates in vendored,
   *    archived or generated trees are dropped, and a very short common word has to be
   *    corroborated by an exported symbol before it binds at all.
   * 2. A TIE IS A QUESTION, NOT A COIN FLIP. Several equally good candidates - "who calls
   *    index" in a repository full of `index.ts` - are returned as candidates for the reader
   *    to choose between, which is what `didYouMean` already renders.
   */
  for (const t of content) {
    const exact = qe.search(t, 40).filter((h) => h.name.toLowerCase() === t && !isBackwater(h.file));
    if (exact.length === 0) continue;
    // Exported and well-connected first: the symbol a question is most likely to be about.
    const ranked = [...exact].sort((a, b) =>
      Number(b.exported) - Number(a.exported) || b.fanIn - a.fanIn || a.file.localeCompare(b.file));
    const best = ranked[0]!;
    if (WEAK_ENTITY_WORDS.has(t) && !best.exported) continue;
    // A tie at the top is genuine ambiguity: same export status, same fan-in, different files.
    const tied = ranked.filter((s) => s.exported === best.exported && s.fanIn === best.fanIn);
    if (tied.length > 1) {
      return { entity: null, ambiguous: tied.slice(0, 5).map((s) => `${s.name} (${s.file}:${s.line})`) };
    }
    return { entity: { kind: "symbol", id: best.id, label: best.name }, didYouMean: [] };
  }

  /*
   * Nothing matched exactly, so offer near misses for the longest content word - the one most
   * likely to be the subject rather than a stray adjective.
   *
   * `QueryEngine.search` is substring-based and cannot help here: the interesting failure is a
   * TYPO, and `loadOrderz` does not appear inside `loadOrder` - the containment runs the other
   * way. Edit distance catches transpositions, doubled letters and a wrong suffix, which is
   * what people actually mistype. Suggestions are never auto-substituted: the reader confirms.
   */
  const probe = [...content].sort((a, b) => b.length - a.length)[0];
  if (!probe) return { entity: null, didYouMean: [] };
  const budget = probe.length <= 4 ? 1 : probe.length <= 8 ? 2 : 3;
  const scored: Array<{ name: string; d: number }> = [];
  const seen = new Set<string>();
  for (const s of corpus.graph.symbols) {
    if (s.kind === "module" || seen.has(s.name)) continue;
    seen.add(s.name);
    const lower = s.name.toLowerCase();
    // Length gate first: an edit distance cannot be below the length difference, so this skips
    // the quadratic comparison for the overwhelming majority of a large graph's symbols.
    if (Math.abs(lower.length - probe.length) > budget) continue;
    const d = editDistance(lower, probe, budget);
    if (d <= budget) scored.push({ name: s.name, d });
  }
  scored.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  const near = scored.slice(0, 5).map((x) => x.name);
  // Substring hits are still worth offering when edit distance found nothing - a reader who
  // typed half a name gets the whole one back.
  return { entity: null, didYouMean: near.length ? near : [...new Set(qe.search(probe, 5).map((s) => s.name))].slice(0, 5) };
}

/**
 * Levenshtein distance, abandoned once every cell in a row exceeds `max`.
 *
 * The cap is what makes this affordable to run against every symbol name in a repository: the
 * caller only cares whether the distance is small, so a row whose best entry is already over
 * budget can never recover and the walk stops there.
 */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Words that steer the query and are therefore never the thing being asked about. */
const RESERVED = new Set(["what", "who", "which", "when", "why", "if", "i", "we", "you", "it", "this", "that", "and", "or", "not", "with", "from", "by", "about", "into", "can", "could", "should", "would", "will"]);

/** `GET /users/:id` or a bare `/users/:id`, matched against the analysed surface only. */
function matchEndpoint(raw: string, api: ApiSurface | undefined): ApiEndpoint | null {
  if (!api) return null;
  const m = raw.match(/\b(get|post|put|patch|delete|head|options)\b\s+(\/\S*)/i);
  if (m) {
    const method = m[1]!.toUpperCase();
    const path = m[2]!;
    return api.endpoints.find((e) => e.method === method && e.routePath.toLowerCase() === path.toLowerCase()) ?? null;
  }
  const p = raw.match(/(^|\s)(\/[a-z0-9_\-/[\]:.$]*)/i);
  if (!p) return null;
  const path = p[2]!.toLowerCase();
  return api.endpoints.find((e) => e.routePath.toLowerCase() === path) ?? null;
}

function row(s: CodeSymbol, detail: string, hops?: number): AskRow {
  return { id: s.id, label: s.name, detail, file: s.file, line: s.line, ...(hops === undefined ? {} : { hops }) };
}

const EXAMPLES = [
  "what breaks if I change buildSymbolGraph",
  "what depends on express",
  "what does indexRepo use",
  "who calls resolveLocalDir",
  "explain POST /api/index",
  "which endpoints are unauthenticated",
  "what are the circular dependencies",
  "what is dead code",
  "what is untested",
  "what are the hubs",
];

/**
 * Compile a question into a plan without executing it.
 *
 * Exported separately from `ask` because the plan is worth asserting on in tests: a change to
 * the cue table should be visible as a change of plan, not only as a change of answer.
 */
export function compileAsk(question: string, corpus: AskCorpus, qe: QueryEngine): AskPlan | AskFailure {
  const raw = normalise(question);
  if (!raw) {
    return { ok: false, question, reason: "unclassified", message: "Ask a question about this repository.", examples: EXAMPLES, didYouMean: [] };
  }
  const tokens = tokenise(raw);
  const { terms: canon, negated } = canonical(tokens);

  let picked: { intent: AskIntent; entity: "required" | "optional" | "none" } | null = null;
  for (const cue of CUES) {
    if (cue.negated !== undefined && cue.negated !== negated) continue;
    const allOk = !cue.all || cue.all.every((c) => canon.includes(c));
    const anyOk = !cue.any || cue.any.some((c) => canon.includes(c));
    if (allOk && anyOk && (cue.all || cue.any)) {
      picked = { intent: cue.intent, entity: cue.entity };
      break;
    }
  }
  if (!picked) {
    return {
      ok: false,
      question,
      reason: "unclassified",
      message: "That question does not map to a query this graph can answer. These forms do:",
      examples: EXAMPLES,
      didYouMean: [],
    };
  }

  let entity: AskEntity | null = null;
  if (picked.entity !== "none") {
    const r = resolveEntity(raw, tokens, corpus, qe);
    entity = r.entity;
    /*
     * An OPTIONAL binding that finds nothing is not a failure - it is the global form of the
     * question. "who wrote this code" names nothing and wants the author list; only a question
     * that CANNOT be answered without a subject gets to refuse.
     */
    if (!entity && picked.entity === "required") {
      /*
       * Two different failures, reported as two different things. "Several symbols fit" is a
       * question back to the reader; "nothing fits" is a dead end with suggestions. Reporting
       * an ambiguity as not-found would tell someone their symbol does not exist when in fact
       * three of them do.
       */
      const ambiguous = r.ambiguous ?? [];
      if (ambiguous.length > 0) {
        return {
          ok: false,
          question,
          reason: "ambiguous",
          message: "More than one thing in this repository fits that name equally well. Pick the one you meant:",
          examples: EXAMPLES,
          didYouMean: ambiguous,
        };
      }
      return {
        ok: false,
        question,
        reason: "entity_not_found",
        message: "No symbol, file, package or endpoint in this repository matches that name.",
        examples: EXAMPLES,
        didYouMean: r.didYouMean ?? [],
      };
    }
  }

  // A dependency question about an external package is a different walk from one about a
  // symbol, so the entity's kind refines the intent rather than the sentence having to say it.
  let intent = picked.intent;
  if (intent === "dependencies_of" && entity?.kind === "package") intent = "package_dependents";
  /*
   * "what depends on the express package" names one and asks who reaches it; "what packages
   * does this use" names none and asks for the list. Refining only on an INBOUND phrasing
   * keeps "what does the vcs package use" - which this index cannot answer, having no
   * package-to-package edges - from being silently answered as its mirror image.
   *
   * The direction is read with `dependencies_of` rather than `package_dependents`, because the
   * latter is DEFINED as inbound and would report so unconditionally. The question is which
   * walk the sentence asked for, not which walk the intent implies.
   */
  if (intent === "packages" && entity?.kind === "package" && directionOf(raw, "dependencies_of") === "inbound") {
    intent = "package_dependents";
  }
  if (intent === "explain_flow" && entity?.kind !== "endpoint" && corpus.api) {
    // "how does X work" about a symbol is answered as its outbound call chain.
    intent = "dependencies_of";
  }

  const direction = directionOf(raw, intent);
  const { transitive, depth } = transitivityOf(canon, intent);
  return { intent, entity, direction, transitive, depth, operations: operationsFor(intent, direction, transitive, depth) };
}

function operationsFor(intent: AskIntent, direction: string, transitive: boolean, depth: number): string[] {
  switch (intent) {
    // `search` never reaches here: `searchFallback` builds its own plan and answer.
    case "search": return ["ranked search"];
    case "impact": return [`QueryEngine.impactWithHops(depth=${depth})`];
    case "package_dependents": return ["VizGraph.depends(inbound)", transitive ? "VizGraph.imports(inbound, transitive)" : "direct importers only"];
    case "dependencies_of": return direction === "inbound" ? ["QueryEngine.callers()"] : [transitive ? `QueryEngine.reachableCallees(depth=${depth})` : "QueryEngine.callees()"];
    case "callers": return ["QueryEngine.callers()"];
    case "callees": return ["QueryEngine.callees()"];
    case "explain_flow": return ["ApiSurface.flows(endpoint)", "hops -> sink"];
    case "endpoints": return ["ApiSurface.endpoints"];
    case "unauthenticated": return ["ApiSurface.endpoints.filter(authenticated === false)"];
    case "dead_code": return ["QueryEngine.deadCode()"];
    case "cycles": return ["QueryEngine.cycles()"];
    case "hubs": return ["QueryEngine.hubs()"];
    case "unused_packages": return ["VizGraph.depends -> external packages", "filter(importers === 0)"];
    // Scope shows in the entity, not the direction: `directionOf` reports `none` for both forms.
    case "ownership": return ["Ownership.files/symbols, or Ownership.authors when nothing is named"];
    case "stale": return ["Ownership.files ranked by staleDays", "busFactor"];
    case "packages": return ["VizGraph.depends -> external packages"];
    case "untested": return ["QueryEngine.deadCode()/fanIn ranking", "isTestFile on callers"];
    case "symbol_search": return ["QueryEngine.search()"];
  }
}

/**
 * What an unclassifiable question gets: a ranked look across everything the index knows.
 *
 * Four corpora, because "where is authentication handled" is not answerable from symbol NAMES
 * alone and never will be:
 *
 *  - SYMBOL TAGS. The extractor already labels symbols `auth`, `db`, `http`, `crypto`, `io`,
 *    `ui`, `error`, `config`, `test`. That is a hand-built topic index sitting unused, and it
 *    is exactly what a conceptual question needs. Deterministic, auditable, no embeddings.
 *  - Symbol names, signatures and doc comments.
 *  - File paths, so "where do we clone repos" finds `acquire.ts`.
 *  - Package names and endpoint routes.
 *
 * Scoring is deliberately crude and explainable — an exact tag or name beats a path segment
 * beats a substring — rather than a similarity metric nobody can reason about. The reader can
 * see in the plan receipt that this was a SEARCH, not a graph answer, which is the honesty the
 * fallback has to preserve: degrading is fine, pretending to have understood is not.
 */
function searchFallback(question: string, corpus: AskCorpus, qe: QueryEngine, failure: AskFailure): AskResult {
  /*
   * The words the question is ABOUT, not the words it is asking WITH.
   *
   * `SYNONYM` holds the cue vocabulary — `find`, `use`, `explain`, `where`, `most`. Those
   * steer the intent; they are never the thing being searched for. Leaving them in made "what
   * should I read first" match every symbol named `read` and return a hundred rows of noise.
   *
   * A TOPIC word survives that filter even when it is also a cue: "authentication" both tells
   * the classifier what kind of question this is AND names the `auth` tag. Dropping it as cue
   * vocabulary is what turned "where is authentication handled" into a list of every function
   * called `handle*`.
   */
  const terms: string[] = [];
  for (const raw of tokenise(normalise(question))) {
    /*
     * A crude singular, because people type plurals and the graph does not contain them:
     * "sessions" has to reach `verifySession`, and `TOPIC_TAG` spells the topic `session`.
     * Stemming properly would need a stemmer and a dictionary; trimming one `s` off a word
     * long enough to survive it covers the case that actually occurs and stays legible.
     */
    const t = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    const topic = TOPIC_TAG.get(raw) ?? TOPIC_TAG.get(t);
    if (topic) { if (!terms.includes(topic)) terms.push(topic); continue; }
    if (STOP.has(raw) || SYNONYM.has(raw) || RESERVED.has(raw) || NEGATORS.has(raw) || t.length <= 2) continue;
    if (!terms.includes(t)) terms.push(t);
  }
  if (terms.length === 0) return failure;

  const scored = new Map<string, { row: AskRow; score: number }>();
  const add = (key: string, score: number, row: AskRow) => {
    const prev = scored.get(key);
    if (!prev || prev.score < score) scored.set(key, { row, score });
  };

  for (const s of corpus.graph.symbols) {
    if (s.kind === "module" || isBackwater(s.file)) continue;
    const name = s.name.toLowerCase();
    const file = s.file.toLowerCase();
    let best = 0;
    let why = "";
    for (const t of terms) {
      // A topic tag is the strongest signal a conceptual question can get: the extractor
      // decided this symbol is about auth/db/http, which no amount of name matching knows.
      if (s.tags.includes(t)) { if (best < 100) { best = 100; why = `tagged ${t}`; } continue; }
      if (name === t) { if (best < 90) { best = 90; why = "exact name"; } continue; }
      if (name.includes(t)) { if (best < 60) { best = 60; why = "name contains it"; } continue; }
      if (file.includes(t)) { if (best < 40) { best = 40; why = "in a matching path"; } continue; }
      if (s.doc && s.doc.toLowerCase().includes(t)) { if (best < 25) { best = 25; why = "mentioned in its doc comment"; } }
    }
    // Exported and well-connected symbols answer a vague question better than a private local.
    if (best > 0) add(s.id, best + Math.min(10, s.fanIn) + (s.exported ? 5 : 0), row(s, `${why} · ${s.kind}`));
  }

  for (const name of corpus.packageImporters?.keys() ?? []) {
    const lower = name.toLowerCase();
    for (const t of terms) {
      if (lower === t || lower.includes(t)) {
        add(`pkg:${name}`, lower === t ? 95 : 55, { id: `pkg:${name}`, label: name, detail: "external package", file: "package.json", line: 1 });
      }
    }
  }

  for (const ep of corpus.api?.endpoints ?? []) {
    const route = `${ep.method} ${ep.routePath}`.toLowerCase();
    for (const t of terms) {
      if (route.includes(t)) add(ep.id, 70, { id: ep.id, label: `${ep.method} ${ep.routePath}`, detail: `endpoint · ${ep.framework}`, file: ep.file, line: ep.line });
    }
  }

  /*
   * TIERED, not merely sorted. A vague question matches a great many things weakly, and a
   * hundred rows ordered by a score nobody can see is the same as no answer. When something
   * scored strongly — a topic tag, an exact name, an endpoint — everything that merely
   * mentioned a term in a path or a doc comment is dropped rather than ranked below it.
   *
   * The cap is 25 and not the 100 the graph answers use: a precise answer's rows are all
   * equally real, whereas a search's tail is where the confidence has already run out.
   */
  const all = [...scored.values()].sort((a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label));
  const strongest = all[0]?.score ?? 0;
  const floor = strongest >= 90 ? 60 : 0;
  const rows = all.filter((x) => x.score >= floor).slice(0, SEARCH_ROWS).map((x) => x.row);
  if (rows.length === 0) return failure;

  const plan: AskPlan = {
    intent: "search",
    entity: null,
    direction: "none",
    transitive: false,
    depth: 0,
    operations: [`ranked search over symbols, tags, paths, packages and endpoints for ${terms.map((t) => `"${t}"`).join(", ")}`],
  };
  return {
    ok: true,
    question,
    plan,
    // Says plainly that it did not understand the question. The rows are still the best thing
    // available, and a reader who sees SEARCH on the receipt knows how much to trust them.
    headline: `That is not a question this graph can answer precisely, so here is what matches ${terms.map((t) => `"${t}"`).join(", ")} — ${count(rows.length, "result")}.`,
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
  };
}
/**
 * Compile and execute.
 *
 * `isTest` is injected rather than imported: the test-file predicate lives in `detect-engine`
 * and in `apps/web`, neither of which this package may depend on. The caller passes the one
 * its half of the product already uses, so the answer here cannot disagree with the answer
 * shown elsewhere in the UI.
 */

export function ask(question: string, corpus: AskCorpus, isTest: (file: string) => boolean): AskResult {
  const qe = new QueryEngine(corpus.graph);
  const compiled = compileAsk(question, corpus, qe);
  if ("ok" in compiled) {
    /**
     * A REFUSAL IS THE WORST AVAILABLE ANSWER, so almost nothing refuses any more.
     *
     * Measured against thirty-five questions written by someone who had not read the cue
     * table: **five answered, thirty refused**. The compiler was not wrong on those thirty —
     * it genuinely could not classify them — but "I cannot answer that" is useless thirty
     * times out of thirty-five, and a surface that useless trains people to stop typing.
     *
     * A closed grammar has bounded recall by construction: it covers the phrasings its author
     * enumerated and no others. That is not a bug to be fixed by more cues, it is the shape of
     * the technique — which is why the systems that do offer open natural-language code
     * questions (Sourcegraph's Deep Search) all put a model behind it, and the ones that stay
     * deterministic (Sourcegraph's own Code Search, GitHub, Zoekt) offer STRUCTURED SEARCH
     * instead and let the user supply the precision.
     *
     * So the floor is search and the ceiling is the graph: an unclassifiable question becomes
     * a ranked lookup across everything the index knows, which is always something a reader
     * can act on. `ambiguous` still refuses, because that one is a genuine question back to
     * the reader rather than an absence of understanding, and `not_analysed` still refuses,
     * because inventing a search result would hide a missing analysis.
     */
    if (compiled.reason === "ambiguous" || compiled.reason === "not_analysed") return compiled;
    return searchFallback(question, corpus, qe, compiled);
  }
  const plan = compiled;
  const e = plan.entity;

  switch (plan.intent) {
    /*
     * Unreachable through `compileAsk`, which never picks `search` — the fallback builds its
     * own plan and returns directly. Present so the switch stays exhaustive: adding an intent
     * should be a type error here, not a silent `undefined` at runtime.
     */
    case "search":
      return searchFallback(question, corpus, qe, {
        ok: false, question, reason: "unclassified", message: "", examples: EXAMPLES, didYouMean: [],
      });
    case "impact": {
      const hits = qe.impactWithHops(e!.id, plan.depth);
      const tests = hits.filter((h) => isTest(h.symbol.file)).length;
      return answer(question, plan, hits.length === 0
        ? `Nothing calls ${e!.label}. Changing it breaks no other symbol in this graph.`
        : `${count(hits.length, "symbol")} reach ${e!.label} within ${plan.depth} hops, across ${count(new Set(hits.map((h) => h.symbol.file)).size, "file")}. ${tests === 0 ? "No test file is on any of those paths." : `${count(tests, "of them is a test", "of them are tests")}.`}`,
        hits.slice(0, MAX_ROWS).map((h) => row(h.symbol, `${h.hops} hop${h.hops === 1 ? "" : "s"} away${isTest(h.symbol.file) ? " · test" : ""}`, h.hops)),
        hits.length > MAX_ROWS);
    }

    case "package_dependents": {
      const importers = corpus.packageImporters?.get(e!.id) ?? [];
      if (!corpus.packageImporters) return notAnalysed(question, "External package imports were not recorded for this index.");
      const direct = [...importers].sort();
      const reached = new Set(direct);
      if (plan.transitive && corpus.fileImporters) {
        const queue = [...direct];
        while (queue.length) {
          const f = queue.shift()!;
          for (const up of corpus.fileImporters.get(f) ?? []) if (!reached.has(up)) { reached.add(up); queue.push(up); }
        }
      }
      const indirect = [...reached].filter((f) => !direct.includes(f)).sort();
      const rows: AskRow[] = [
        ...direct.map((f) => ({ id: f, label: f, detail: `imports ${e!.label} directly`, file: f, line: 1, hops: 1 })),
        ...indirect.map((f) => ({ id: f, label: f, detail: `reaches ${e!.label} through another file`, file: f, line: 1, hops: 2 })),
      ];
      return answer(question, plan, direct.length === 0
        ? `No file in this repository imports ${e!.label}. It is declared as a dependency but nothing here uses it.`
        : `${count(direct.length, "file")} import ${e!.label} directly${indirect.length ? `, and ${count(indirect.length, "more file reaches", "more files reach")} it through another file` : ""}.`,
        rows.slice(0, MAX_ROWS), rows.length > MAX_ROWS);
    }

    case "dependencies_of": {
      if (e!.kind !== "symbol") {
        const inFile = corpus.graph.symbols.filter((s) => s.file === e!.id && s.kind !== "module");
        return answer(question, plan, `${e!.label} defines ${count(inFile.length, "symbol")}.`,
          inFile.slice(0, MAX_ROWS).map((s) => row(s, `${s.kind} · ${s.fanIn} caller${s.fanIn === 1 ? "" : "s"}`)), inFile.length > MAX_ROWS);
      }
      if (plan.direction === "inbound") {
        const callers = qe.callers(e!.id);
        return answer(question, plan, callers.length === 0 ? `Nothing calls ${e!.label}.` : `${count(callers.length, "symbol calls", "symbols call")} ${e!.label} directly.`,
          callers.slice(0, MAX_ROWS).map((s) => row(s, `calls ${e!.label}`, 1)), callers.length > MAX_ROWS);
      }
      const hits = plan.transitive ? qe.reachableCallees(e!.id, plan.depth) : qe.callees(e!.id).map((s) => ({ symbol: s, hops: 1 }));
      return answer(question, plan, hits.length === 0 ? `${e!.label} calls nothing the graph resolved.` : `${e!.label} reaches ${count(hits.length, "symbol")}${plan.transitive ? ` within ${plan.depth} hops` : " directly"}.`,
        hits.slice(0, MAX_ROWS).map((h) => row(h.symbol, `${h.hops} hop${h.hops === 1 ? "" : "s"}`, h.hops)), hits.length > MAX_ROWS);
    }

    case "explain_flow": {
      if (!corpus.api) return notAnalysed(question, "The API surface was not analysed for this index.");
      const ep = corpus.api.endpoints.find((x) => x.id === e!.id)!;
      const flows = corpus.api.flows.filter((f) => f.endpointId === ep.id);
      const chains = flows.slice(0, 8).map((f) => ({ title: `${ep.method} ${ep.routePath}`, steps: chainSteps(ep, f), sink: `${f.sink.kind} · ${f.sink.evidence}` }));
      const guard = ep.authenticated === true ? `It is guarded (${ep.authEvidence ?? "guard found"}).`
        : ep.authenticated === false ? "No guard was found on the handler's reachable set — treat as triage, not a verdict."
        : "Whether it is guarded could not be determined: the handler did not resolve.";
      return answer(question, plan,
        flows.length === 0
          ? `${ep.method} ${ep.routePath} is declared in ${ep.file}:${ep.line} (${ep.framework}). No data-flow path from its handler to a sink was resolved. ${guard}`
          : `${ep.method} ${ep.routePath} is handled in ${ep.file}:${ep.line} (${ep.framework}) and reaches ${count(flows.length, "sink")}. ${guard}`,
        flows.slice(0, MAX_ROWS).map((f) => ({ id: f.hops[f.hops.length - 1]?.symbolId ?? ep.id, label: chainSteps(ep, f).join(" → "), detail: `${f.sink.kind} sink · ${f.sink.evidence}`, file: f.hops[f.hops.length - 1]?.file ?? ep.file, line: f.hops[f.hops.length - 1]?.line ?? ep.line })),
        corpus.api.truncated, chains);
    }

    case "endpoints": {
      if (!corpus.api) return notAnalysed(question, "The API surface was not analysed for this index.");
      const eps = corpus.api.endpoints;
      return answer(question, plan, `${count(eps.length, "endpoint")} declared across ${count(new Set(eps.map((x) => x.file)).size, "file")}.`,
        eps.slice(0, MAX_ROWS).map((x) => ({ id: x.id, label: `${x.method} ${x.routePath}`, detail: `${x.framework}${x.pathIsDynamic ? " · path partly dynamic" : ""}${x.authenticated === false ? " · no guard found" : x.authenticated === true ? " · guarded" : " · guard unknown"}`, file: x.file, line: x.line })),
        corpus.api.truncated || eps.length > MAX_ROWS);
    }

    case "unauthenticated": {
      if (!corpus.api) return notAnalysed(question, "The API surface was not analysed for this index.");
      const open = corpus.api.endpoints.filter((x) => x.authenticated === false);
      const unknown = corpus.api.endpoints.filter((x) => x.authenticated === null).length;
      return answer(question, plan,
        open.length === 0
          ? `No endpoint was found without a guard.${unknown ? ` ${count(unknown, "endpoint")} could not be determined.` : ""}`
          : `${count(open.length, "endpoint has", "endpoints have")} no guard on the handler's reachable set.${unknown ? ` A further ${count(unknown, "endpoint")} could not be determined and ${unknown === 1 ? "is" : "are"} excluded.` : ""} This is a triage list, not a verdict: a guard applied as framework middleware reads as absent here.`,
        open.slice(0, MAX_ROWS).map((x) => ({ id: x.id, label: `${x.method} ${x.routePath}`, detail: x.framework, file: x.file, line: x.line })),
        corpus.api.truncated);
    }

    case "dead_code": {
      const dead = qe.deadCode();
      return answer(question, plan, dead.length === 0 ? "Every symbol in this graph has a resolved caller." : `${count(dead.length, "symbol has", "symbols have")} no resolved caller and no entrypoint marker. Unresolved dynamic dispatch reads as dead here, so confirm before deleting.`,
        dead.slice(0, MAX_ROWS).map((s) => row(s, `${s.kind}${s.exported ? " · exported" : ""}`)), dead.length > MAX_ROWS);
    }

    case "cycles": {
      const cycles = qe.cycles();
      return answer(question, plan, cycles.length === 0 ? "No call cycle was found." : `${count(cycles.length, "call cycle")} found.`,
        cycles.slice(0, MAX_ROWS).map((c, i) => {
          const first = qe.get(c[0]!);
          return { id: `cycle:${i}`, label: c.map((id) => qe.get(id)?.name ?? id).join(" → "), detail: `${c.length} symbols`, file: first?.file ?? "", line: first?.line ?? 1 };
        }), cycles.length > MAX_ROWS);
    }

    case "hubs": {
      const hubs = qe.hubs(MAX_ROWS);
      return answer(question, plan, hubs.length === 0 ? "This graph has no resolved call edges, so it has no hubs." : `The ${count(Math.min(hubs.length, 20), "symbol")} with the most connections.`,
        hubs.slice(0, 20).map((s) => row(s, `${s.fanIn} in · ${s.fanOut} out`)), false);
    }

    /*
     * Who wrote it, who owns it, who should review it.
     *
     * Three questions, one walk, because they are all the same table read at different scopes.
     * A named FILE gets its owners; a named SYMBOL gets the commits whose changed lines fell
     * inside its span, falling back to its file when history never touched it precisely; and a
     * question that names nothing gets the author list, which is what "who wrote this code"
     * is actually asking.
     *
     * The share is stated as a share of COMMITS TOUCHING THAT FILE, not of the code in it.
     * Anyone reading "82%" will assume the second unless the row says otherwise, and the
     * analyser cannot support that claim - it never attributed a line to an author.
     */
    case "ownership": {
      const own = corpus.ownership;
      if (!own) return notAnalysed(question, "Git history was not analysed for this repository, so it has no ownership data.");
      if (e && (e.kind === "file" || e.kind === "symbol")) {
        const file = e.kind === "file" ? e.id : qe.get(e.id)?.file ?? "";
        const sym = e.kind === "symbol" ? own.symbols.find((s) => s.symbolId === e.id) : undefined;
        const entry = own.files.find((f) => f.path === file);
        // A symbol whose span no commit intersected is not unowned - it is inside a file that
        // someone owns, and saying "nobody" there would be a false negative on a review question.
        const owners = sym && sym.owners.length > 0
          ? sym.owners.map((o) => ({ author: o.author, share: o.share, commits: 0 }))
          : entry?.owners ?? [];
        if (owners.length === 0) {
          return answer(question, plan, `No commit in the last ${own.windowDays} days touched ${e.label}, so this window cannot say who owns it.`, [], false);
        }
        const scope = sym && sym.owners.length > 0 ? `commits intersecting ${e.label}` : `commits touching ${file}`;
        return answer(question, plan,
          `${owners[0]!.author} has the largest share of ${scope} (${Math.round(owners[0]!.share * 100)}% over ${own.windowDays} days)${entry && entry.busFactor === 1 ? ", and is the only substantial author - a bus factor of one" : ""}.`,
          owners.slice(0, MAX_ROWS).map((o, i) => ({
            id: `owner:${o.author}:${i}`,
            label: o.author,
            detail: `${Math.round(o.share * 100)}% of ${scope}${o.commits ? ` · ${count(o.commits, "commit")}` : ""}`,
            file: file || e.label,
            line: 1,
          })), false);
      }
      const authors = [...own.authors].sort((a, b) => b.commits - a.commits);
      return answer(question, plan,
        authors.length === 0
          ? `No commits were found in the last ${own.windowDays} days.`
          : `${count(authors.length, "author has", "authors have")} committed in the last ${own.windowDays} days. Name a file or symbol to see who owns it specifically.`,
        authors.slice(0, MAX_ROWS).map((a) => ({
          id: `author:${a.name}`,
          label: a.name,
          detail: `${count(a.commits, "commit")} · ${count(a.filesTouched, "file")} touched`,
          file: "",
          line: 1,
        })), authors.length > MAX_ROWS);
    }

    /*
     * Where the knowledge has left the building.
     *
     * Ranked by RISK rather than by age, because old is not the same as dangerous: a stable
     * file nobody needs to touch is fine, and a file whose only author left is not. Orphaned
     * first, then bus-factor-one, then age - and the row says which of the three it is, so the
     * reader can disagree with the ordering rather than having to trust it.
     */
    case "stale": {
      const own = corpus.ownership;
      if (!own) return notAnalysed(question, "Git history was not analysed for this repository, so it has no staleness data.");
      /*
       * Only paths this index actually analysed.
       *
       * `ownership.files` is built from COMMIT HISTORY, so it holds every path that ever
       * existed - renamed, deleted, moved between packages. Measured on this repository that
       * was 2,639 entries against 350 analysed files: an answer mostly composed of paths the
       * reader cannot open, which is worse than no answer.
       */
      const present = new Set(corpus.graph.symbols.map((s) => s.file));
      /*
       * A bus factor of one is only a finding when somebody else COULD have known.
       *
       * In a single-author repository every file is bus-factor-one by definition, so the
       * criterion carries no information and flags the entire codebase. Suppressed rather than
       * silently dropped: the headline says the criterion did not apply, because "nothing is
       * stale" and "I could not tell" are different claims.
       */
      const busFactorDiscriminates = own.authors.length > 1;
      const risky = own.files
        .filter((f) => present.has(f.path)
          && (f.orphaned || (busFactorDiscriminates && f.busFactor === 1) || (f.staleDays ?? 0) > own.windowDays))
        .sort((a, b) => Number(b.orphaned) - Number(a.orphaned) || a.busFactor - b.busFactor || (b.staleDays ?? 0) - (a.staleDays ?? 0));
      const orphaned = risky.filter((f) => f.orphaned).length;
      const soloNote = busFactorDiscriminates ? "" : ` Only one author has committed here, so a bus factor of one describes every file and was not counted as risk.`;
      return answer(question, plan,
        risky.length === 0
          ? `No analysed file is orphaned${busFactorDiscriminates ? ", carried by a single author," : ""} or untouched for longer than ${own.windowDays} days.${soloNote}`
          : `${count(risky.length, "file")} carry maintenance risk${orphaned ? `, ${orphaned} of them orphaned - every author inactive in the window` : ""}. Ranked by risk, not by age: a file nobody needs to touch is not a problem, a file nobody left understands is.${soloNote}`,
        risky.slice(0, MAX_ROWS).map((f) => ({
          id: f.path,
          label: f.path,
          detail: f.orphaned
            ? `orphaned · last touched ${f.staleDays ?? "?"} days ago`
            : f.busFactor === 1
              ? `single author (${f.owners[0]?.author ?? "unknown"}) · last touched ${f.staleDays ?? "?"} days ago`
              : `untouched for ${f.staleDays ?? "?"} days`,
          file: f.path,
          line: 1,
        })), risky.length > MAX_ROWS);
    }

    /*
     * The external surface: what this repository pulls in from outside.
     *
     * Ordered by how many files import it, because that is the replacement cost - the number a
     * "can we drop this" question is really asking for. A declared package nothing imports is
     * kept and labelled rather than filtered out: it is the most actionable row in the list.
     */
    case "packages": {
      if (!corpus.packageImporters) return notAnalysed(question, "External package imports were not recorded for this index.");
      const pkgs = [...corpus.packageImporters.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      const unused = pkgs.filter(([, f]) => f.length === 0).length;
      return answer(question, plan,
        pkgs.length === 0
          ? "No external package is declared or imported by this repository."
          : `${count(pkgs.length, "external package")}, ordered by how many files import each${unused ? `. ${count(unused, "is", "are")} declared but imported nowhere` : ""}.`,
        pkgs.slice(0, MAX_ROWS).map(([name, importers]) => ({
          id: `pkg:${name}`,
          label: name,
          detail: importers.length === 0 ? "declared, imported by nothing here" : `imported by ${count(importers.length, "file")}`,
          file: importers[0] ?? "package.json",
          line: 1,
        })), pkgs.length > MAX_ROWS);
    }

    /*
     * The removable subset, as its own answer rather than as a footnote on the full list.
     *
     * "Which libraries are unused" used to compile to `dead_code` and come back with a hundred
     * dead SYMBOLS, because `unused` folds to `dead` and that rule sat higher in the table.
     * Listing all 53 packages with the fourteen unused ones sorted to the bottom would be a
     * quieter version of the same failure: the reader asked a narrower question than the one
     * being answered.
     */
    case "unused_packages": {
      if (!corpus.packageImporters) return notAnalysed(question, "External package imports were not recorded for this index.");
      const unused = [...corpus.packageImporters.entries()].filter(([, f]) => f.length === 0).map(([name]) => name).sort();
      return answer(question, plan,
        unused.length === 0
          ? `Every one of the ${count(corpus.packageImporters.size, "declared package")} is imported by at least one file.`
          : `${count(unused.length, "declared package is", "declared packages are")} imported by no file in this repository. A build tool or a config file may still need ${unused.length === 1 ? "it" : "them"}, so confirm before removing.`,
        unused.slice(0, MAX_ROWS).map((name) => ({
          id: `pkg:${name}`,
          label: name,
          detail: "declared, imported by nothing here",
          file: "package.json",
          line: 1,
        })), unused.length > MAX_ROWS);
    }

    case "untested": {
      const hubs = qe.hubs(60).filter((s) => s.fanIn >= 2 && qe.callers(s.id).every((c) => !isTest(c.file)));
      return answer(question, plan, hubs.length === 0 ? "Every hub in this graph has a test caller." : `${count(hubs.length, "hub")} with callers but no test on any inbound path.`,
        hubs.slice(0, MAX_ROWS).map((s) => row(s, `${s.fanIn} callers, none of them tests`)), false);
    }

    case "symbol_search": {
      const hits = qe.search(e!.label, MAX_ROWS);
      return answer(question, plan, hits.length === 0 ? `Nothing named ${e!.label}.` : `${count(hits.length, "symbol")} matching ${e!.label}.`,
        hits.map((s) => row(s, `${s.kind} · ${s.fanIn} caller${s.fanIn === 1 ? "" : "s"}`)), false);
    }

    case "callers":
    case "callees": {
      const list = plan.intent === "callers" ? qe.callers(e!.id) : qe.callees(e!.id);
      return answer(question, plan, `${count(list.length, "symbol")}.`, list.slice(0, MAX_ROWS).map((s) => row(s, s.kind, 1)), list.length > MAX_ROWS);
    }
  }
}

/** `POST /orders → OrderController → OrderService → Stripe`, built only from resolved hops. */
function chainSteps(ep: ApiEndpoint, f: DataFlowPath): string[] {
  return [`${ep.method} ${ep.routePath}`, ...f.hops.map((h) => h.name)];
}

function answer(question: string, plan: AskPlan, headline: string, rows: readonly AskRow[], truncated: boolean, chains?: AskAnswer["chains"]): AskAnswer {
  return { ok: true, question, plan, headline, rows, truncated, ...(chains ? { chains } : {}) };
}

function notAnalysed(question: string, message: string): AskFailure {
  return { ok: false, question, reason: "not_analysed", message: `${message} Re-index this repository to populate it.`, examples: EXAMPLES, didYouMean: [] };
}

/**
 * Agreement without a pluralisation library.
 *
 * Two forms because English marks number on the verb as well as the noun, and "1 symbols reach"
 * and "3 symbol reaches" are both wrong in ways a reader notices immediately.
 */
function count(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;
}
