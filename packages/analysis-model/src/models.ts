import type { StageTimings } from "./pipeline";
import type { SymbolGraph } from "@codegraph/core-graph";

/**
 * The v1 analysis output models.
 *
 * Moved verbatim from `apps/web/src/lib/types.ts` (LLD §13.2). These are the
 * shapes `indexRepo` and `scoreIssues` PRODUCE, which is why they travel with the
 * pipeline rather than staying behind as app view types. The app's own view and
 * API models (`RepoDetail`, `RepoSummary`, `Fleet*`, `TrashEntry`, `Assistant*`,
 * `Job`) stayed in `apps/web`, because nothing here produces them.
 *
 * NOT `core-domain`'s model, and deliberately not merged with it. `core-domain`
 * declares the v2 taxonomy, and the two have diverged:
 *
 *   core-domain `Dimension`: 6 members, includes "performance"
 *   this `Dimension`       : 5 members, no "performance"
 *
 * `scoreIssues` computes the overall score as `Σ score × weight` over
 * `DIMENSION_META`, whose five weights sum to exactly 1.0. Adopting the
 * six-member type forces a sixth weight taken from the other five, which moves
 * every repository's Health Score — a behaviour change P2 may not make.
 * `"performance"` is not missing by oversight either: it is an *agent*, and the
 * swarm's `Finding` carries `agent` with no `dimension` field at all. Whether it
 * earns score weight, and from where, is a real P3 design question.
 */

export type Dimension =
  | "correctness"
  | "security"
  | "maintainability"
  | "dependency_hygiene"
  | "test_integrity";

/** Mirrors `@codegraph/analysis`'s ScanCoverage. Declared here because IndexResult carries it
 *  and this package is the client-safe home for everything the UI renders. */
/**
 * Organisational signals per file (PLAN.md §5.2), mirroring `@codegraph/vcs`'s FileSignals.
 *
 * REPORTED, NOT SCORED. Nothing here feeds the Health Score: hand-weighting eight new markers
 * would add eight hand-picked constants to a model whose stated problem is that its one
 * constant was hand-picked. §5.3 fits them against a labelled defect corpus.
 */
export interface FileSignals {
  churn: number;
  authors: number;
  ownershipRatio: number;
  busFactor: number;
  coChangeScatter: number;
  changeEntropy: number;
  knowledgeLoss: number;
  priorDefect: number;
  ageVolatility: number;
}

/**
 * Ownership derived from git history, mirroring `@codegraph/vcs`'s `ownership.ts`.
 *
 * Mirrored rather than imported, exactly as `FileSignals` above is and for the same reason:
 * `vcs` sits below this package in the layer graph, and this package is the client-safe home
 * for everything the UI renders.
 *
 * WHAT THESE MEASURE, AND WHAT THEY DO NOT. Every number here is a share of COMMITS, not of
 * lines: git attributes a commit to a file, and reconstructing per-line authorship for a whole
 * tree means a blame per file. So "owns 62%" means "made 62% of the commits that touched
 * this", which is the standard proxy and is not the same claim.
 */
export interface AuthorStat {
  readonly name: string;
  readonly email: string;
  readonly commits: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly filesTouched: number;
}

export interface FileOwner {
  readonly author: string;
  /** 0..1 share of the commits that touched this file. */
  readonly share: number;
  readonly commits: number;
  readonly lastAt: number;
}

export interface OwnershipEntry {
  readonly path: string;
  /** Descending by share. Capped for display; `busFactor` is computed over ALL owners. */
  readonly owners: readonly FileOwner[];
  readonly busFactor: number;
  /** Days since the last commit touching it, or null when the window carries no timestamp. */
  readonly staleDays: number | null;
  /** Every owner is inactive in the recent window — nobody who knows this is still here. */
  readonly orphaned: boolean;
}

/**
 * Commits attributed to a symbol by intersecting changed line ranges with its span.
 *
 * APPROXIMATE BY CONSTRUCTION, and the UI must not imply otherwise. Symbol spans come from the
 * CURRENT tree while the ranges come from history, and a symbol that moved is matched against
 * where it is now, not where it was. Resolving that exactly would mean re-extracting the graph
 * at every commit.
 */
export interface SymbolOwnership {
  readonly symbolId: string;
  readonly owners: ReadonlyArray<{ author: string; share: number }>;
}

export interface OwnershipReport {
  readonly authors: readonly AuthorStat[];
  readonly files: readonly OwnershipEntry[];
  readonly symbols: readonly SymbolOwnership[];
  readonly windowDays: number;
  readonly commitsAnalysed: number;
  /** A bound was hit, so this is a partial view rather than the whole history. */
  readonly truncated: boolean;
}

/**
 * One file the scanner read, as handed to every downstream stage.
 *
 * Lives in the shared model rather than the pipeline because it is the INPUT CONTRACT of the
 * stages LLD §13 splits out - `viz`, `detect-engine` and the rest each take these. Leaving it
 * inside `indexer.ts` would make every extracted package import the thing it was extracted
 * from, which is the coupling the split exists to remove.
 */
/**
 * Extension to language name. Shared reference data: the scanner uses it to attribute LOC and
 * `viz` uses it to colour a node, and two copies would let the graph disagree with the language
 * table beside it.
 */
export const CODE_EXTS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true,
  ".cjs": true, ".py": true, ".go": true, ".rs": true, ".java": true,
  ".rb": true, ".php": true, ".c": true, ".h": true, ".cpp": true,
  ".hpp": true, ".cs": true, ".swift": true, ".kt": true,
};

export const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go",
  ".rs": "Rust", ".java": "Java", ".rb": "Ruby", ".php": "PHP", ".c": "C",
  ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".swift": "Swift",
  ".kt": "Kotlin", ".scala": "Scala", ".sh": "Shell", ".sql": "SQL",
  ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".md": "Markdown",
  ".json": "JSON", ".yml": "YAML", ".yaml": "YAML",
};

export interface ScannedFile {
  rel: string;
  ext: string;
  loc: number;
  text: string;
  /**
   * SHA-1 of the file's exact bytes as read.
   *
   * The ONLY identity the incremental index trusts. `mtime`/`size` were considered and
   * rejected: a same-second rewrite, a checkout that restores an old file, and a
   * `git stash` round-trip all preserve both while changing the content, and every one of
   * those produces a silently stale analysis — the failure mode a cache must not have.
   * Hashing costs one pass over bytes already in memory.
   */
  hash: string;
  /** Resolved-ish relative import targets. */
  imports: string[];
}

export interface ScanCoverage {
  filesSeen: number;
  /** Files the walk kept. NOT the number analysed — see filesAnalysed. */
  filesKept: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
  capHit: boolean;
  unvisitedDirs: number;
  /** Nested git repositories skipped — clones, vendored checkouts, submodules. */
  skippedNestedRepos: number;
  /**
   * Entries excluded by the project's own `.gitignore`.
   *
   * ENTRIES, not files: a wholly-ignored directory is pruned as one rather than descended to
   * count its contents, so this is a lower bound. Optional because a run from before the walk
   * consulted git has no value to report — absent means "not measured", which is a different
   * statement from `0`, "nothing was ignored".
   */
  skippedIgnored?: number;
  /**
   * Files kept by the walk but skipped by the scan for having no language mapping.
   *
   * Usually the largest single category and usually benign - images, lockfiles, binaries. It is
   * reported anyway because "benign" is a judgement the operator should make: a repository that
   * is 90% an unsupported language reads as well-covered otherwise.
   */
  skippedNoLanguage: number;
  /** Lines of code across the files that were actually scanned. */
  locAnalysed: number;
  /** Files actually read and scanned - `filesKept` minus `skippedNoLanguage`. */
  filesAnalysed: number;
  /**
   * LOC by analysis tier (HLD §8.3). Optional so runs indexed before this keep deserialising.
   *
   * The health report publishes "% of LOC at tier >= ast" from this, so a repository that is
   * mostly Python is honest about being scanned by regex rather than quietly scoring as though
   * it had been parsed. `ast` is defined but not currently produced - see `AnalysisTier`.
   */
  tierLoc?: Partial<Record<"full" | "ast" | "lexical" | "skipped", number>>;
}

export interface DimensionScore {
  dimension: Dimension;
  score: number; // 0..100
  penalty: number; // raw accumulated penalty
  issueCount: number;
}

export interface Issue {
  id: string;
  dimension: Dimension;
  severity: number; // 1..5
  confidence?: number; // 0..1
  title: string;
  file: string;
  line: number;
  blastRadius: number; // >=1, graph fan-in weighting
  churn?: number; // commit count over last 6mo, for hotspot prioritization
  /**
   * Total matches for this rule in this file, when it exceeds the per-rule
   * emit cap.
   *
   * Set on the FIRST emitted issue of a (rule, file) group only — the others
   * are location markers for the UI, and multiplying the volume factor once per
   * emitted issue would count the same excess five times. `undefined` means
   * "at or under the cap", which is the common case and scores exactly as it
   * did before this field existed (review item B3).
   */
  occurrences?: number;
  /**
   * Stable machine identity of the rule that produced this finding, e.g.
   * `hardcoded-secret` or `security/detect-non-literal-fs-filename`.
   *
   * `title` cannot serve: it is prose, it is localised nowhere but it IS dynamic
   * (`Large file (656 LOC)`, `Unpinned dependency: react (^18)`), so anything keyed on it —
   * a suppression, a baseline entry, a SARIF rule, a "which rule is drowning me" tally —
   * re-keys itself the moment the file grows a line. Optional ONLY so rows persisted before
   * this field keep deserialising; every producer sets it, and readers should go through
   * `ruleIdOf`.
   */
  rule?: string;
  /**
   * One line a human can check without opening the file: the matched text, the taint
   * verdict, the count that tripped a threshold. A finding you cannot falsify in five
   * seconds is a finding nobody acts on.
   */
  evidence?: string;
  /**
   * Accepted by the repository — an inline `codegraph-ignore` or an entry in
   * `.codegraph-baseline.json`. Still reported, deliberately: a suppression that hides its
   * own existence is how a baseline becomes a place findings go to die. Excluded from the
   * Health Score and from CI gates.
   */
  suppressed?: boolean;
}

export interface LanguageStat {
  language: string;
  files: number;
  loc: number;
}

export interface GraphStats {
  nodes: number; // files + dirs + deps
  edges: number; // imports + containment
  files: number;
  dirs: number;
  dependencies: number;
}

// --- Visualization graph (the actual node/edge network to render) ---
export type GraphNodeKind = "dir" | "file" | "dependency";

export interface GraphNode {
  id: string; // path (files/dirs) or "dep:name"
  label: string; // short display name
  kind: GraphNodeKind;
  language: string | null;
  loc: number;
  fanIn: number; // how many files import this (centrality)
  issues: number; // issue count attributed to this node
  worstSeverity: number; // 0..5
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "imports" | "contains" | "depends";
}

export interface VizGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean; // true if capped for rendering
}

// --- File tree for circle-packing visualization ---
export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[]; // present on directories
  ext?: string; // present on files, e.g. ".ts"
  loc?: number; // present on files
  issues?: number; // present on files
}

// --- Module-level architecture graph (flowchart) ---
export interface ModuleNode {
  id: string; // top-level dir name, or "(root)"
  label: string;
  files: number;
  loc: number;
  issues: number;
  language: string | null; // dominant language
  tier: number; // dependency layer for layout
}

export interface ModuleEdge {
  source: string;
  target: string;
  weight: number; // number of imports between modules
}

export interface ModuleGraph {
  nodes: ModuleNode[];
  edges: ModuleEdge[];
}

/**
 * What the incremental path actually did (ADR-008's disclosure rule, applied to reuse).
 *
 * A run that reused 900 of 903 files and a run that re-analysed everything produce the same
 * score, and the operator cannot tell them apart from the score. When a cache is wrong, the
 * only cheap way to find out is to see that it was USED — so every run says so, including
 * the ones that refused to use it and why.
 */
export interface IncrementalReport {
  mode: "full" | "incremental";
  /** Why the mode is what it is: "no cache", "engine version changed", "reused 900/903", … */
  reason: string;
  filesTotal: number;
  /** Added or modified since the cached manifest. */
  filesChanged: number;
  /** Files whose symbol extraction was reused rather than recomputed. */
  filesReused: number;
  /** Whether this run left a usable cache behind for the next one. */
  cacheWritten: boolean;
}

// --- Dependency supply chain (produced by @codegraph/analysis) ---

/**
 * Dependency intelligence and vulnerability advisories, mirroring `@codegraph/analysis`'s
 * `depintel.ts` and `advisories.ts`.
 *
 * Mirrored rather than imported, for the reason `FileSignals` and `OwnershipReport` above are:
 * this package is the client-safe home for everything the UI renders, and it sits below the
 * analysis package that produces these.
 *
 * A previous pass declared a RICHER set of shapes here — `DeclaredDependency`, a
 * `VersionSource` union, a `DependencyEcosystem`, structured `blastRadius` entries — before
 * the code that would fill them existed, and the implementations then landed with a different
 * shape. Two definitions of one concept is worse than either, and a type nothing produces is
 * scaffolding, so these now mirror what the modules actually return. Widen them when the
 * producer widens, not before.
 */
export type DependencyScope =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

export interface Advisory {
  readonly id: string;
  readonly package: string;
  readonly installedVersion: string | null;
  readonly severity: "critical" | "high" | "medium" | "low" | "unknown";
  readonly summary: string;
  readonly fixedIn: string | null;
  readonly url: string | null;
  /** Declared in a manifest, as opposed to reached only through the lockfile. */
  readonly direct: boolean;
  /**
   * Matched against a manifest RANGE rather than a locked version.
   *
   * The distinction is load-bearing. `^4.17.20` with the `^` stripped is not "4.17.20 is
   * installed" — the tree may hold 4.17.21, which is the version that fixes the advisory this
   * would otherwise report. An approximate hit says "a package matching this range may be
   * affected", which is a weaker claim, and rendering it as a precise one is what makes a
   * vulnerability report untrustworthy.
   */
  readonly approximateMatch: boolean;
}

export interface AdvisoryReport {
  /** Explicitly discriminated: an unchecked scan must NEVER read as "clean". */
  readonly status: "checked" | "unavailable" | "disabled";
  /**
   * Why the check did not happen — and, on a `checked` report, why it was PARTIAL. A non-null
   * `reason` beside `status: "checked"` means the list is real but incomplete (the package cap
   * bit, or versions could not be resolved and so were never queried). Rendering must surface
   * it on `checked` too, not only on the failure states.
   */
  readonly reason: string | null;
  readonly advisories: readonly Advisory[];
  /**
   * Packages actually sent to the advisory database. Lower than the number scanned whenever
   * the cap bit or a version was unresolvable; that difference is the honest measure of the
   * gap between what was scanned and what was checked.
   */
  readonly packagesQueried: number;
  /** Non-null only when a check completed. `unavailable` and `disabled` never carry a time. */
  readonly checkedAt: number | null;
}

/**
 * A declared dependency that nothing in the scanned source imports.
 *
 * A CANDIDATE, never a verdict. The naive version of this check is wrong often enough to be
 * useless: a linter plugin named only in a config file, a CLI invoked from `scripts`, and a
 * types package the compiler picks up without an import statement are all "never imported" and
 * all genuinely used. Each of those either excludes the package or lowers `confidence` and
 * fills `caveat`, so the reader can see which rule was uncertain and why.
 */
export interface UnusedDependency {
  readonly name: string;
  /** Manifest path the declaration came from, repo-relative. */
  readonly declaredIn: string;
  readonly scope: DependencyScope;
  /** 0..1, derived. Never 1.0 — computed `require()` and bundler aliases are invisible here. */
  readonly confidence: number;
  /** Why this might be a false positive. `null` only when nothing downgraded it. */
  readonly caveat: string | null;
}

/** One place a package specifier was written. */
export interface PackageImportSite {
  readonly file: string;
  readonly line: number;
  /** Enclosing symbol, or `null` when the import sits outside every extracted symbol. */
  readonly symbolId: string | null;
}

/**
 * What breaks if this library is swapped out.
 *
 * Two layers, kept apart because they carry different certainty: `importSites` is observed
 * text, `blastRadius` is transitive callers derived from resolved call edges — real, but only
 * as complete as the graph's resolution.
 */
export interface ReplacementImpact {
  readonly package: string;
  readonly importSites: readonly PackageImportSite[];
  /** Symbols defined in the files that import the package. */
  readonly directSymbols: readonly string[];
  /** Transitive callers of `directSymbols`, excluding the direct symbols themselves. */
  readonly blastRadius: readonly string[];
  /** A cap was hit, or the symbol graph was already truncated — this is a lower bound. */
  readonly truncated: boolean;
}

/**
 * APIs as first-class entities, and inter-procedural taint, mirroring `@codegraph/core-graph`'s
 * `api.ts` and `taint.ts` for the same layering reason as the shapes above.
 */
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY";
export type ApiSinkKind = "database" | "filesystem" | "network" | "process";

export interface ApiEndpoint {
  /** `${method} ${routePath}`. Two registrations of the same pair collapse to one endpoint. */
  readonly id: string;
  readonly method: ApiMethod;
  readonly routePath: string;
  readonly file: string;
  readonly line: number;
  readonly framework: string;
  readonly handlerSymbolId: string | null;
  /**
   * The registered path was not a string literal. `routePath` then holds the best literal text
   * available — a mount prefix, a template's static chunks — and never a guessed completion.
   */
  readonly pathIsDynamic: boolean;
  /**
   * THREE-VALUED, and the third value is the point. `null` means the handler could not be
   * resolved, so no claim is made; `false` means it was resolved and its reachable set
   * genuinely contains no guard. Only `false` belongs in a security finding, and collapsing
   * the two would turn every analysis gap into an accusation.
   */
  readonly authenticated: boolean | null;
  readonly authEvidence: string | null;
}

export interface DataFlowPath {
  readonly endpointId: string;
  /** The call chain: `hops[0]` is the handler, the last hop is the sink symbol. */
  readonly hops: ReadonlyArray<{ symbolId: string; name: string; file: string; line: number }>;
  readonly sink: { kind: ApiSinkKind; symbolId: string; evidence: string };
}

export interface ApiSurface {
  readonly endpoints: readonly ApiEndpoint[];
  readonly flows: readonly DataFlowPath[];
  /** A cap was hit: the answer is a prefix of the truth, not the truth. */
  readonly truncated: boolean;
}

/**
 * One untrusted value that reaches a dangerous sink.
 *
 * A claim about DATA, not about reachability: the value is followed argument-index to
 * parameter-index across resolved calls, so a path here means the tainted value actually
 * arrives at the sink rather than merely that the two functions are connected.
 */
export interface TaintPath {
  readonly id: string;
  readonly source: { symbolId: string; file: string; line: number; evidence: string; kind: string };
  readonly sink: { symbolId: string; file: string; line: number; evidence: string; rule: string };
  readonly hops: ReadonlyArray<{ symbolId: string; name: string; file: string; line: number }>;
  /**
   * A sanitizer was found on the path. Reported rather than dropped: "we checked and it is
   * guarded" is worth more to a reader than silence, and silently discarding defended paths
   * makes the remaining list impossible to calibrate against.
   */
  readonly sanitized: boolean;
  /** 0..1, DERIVED from edge resolution quality and chain length. Never a constant. */
  readonly confidence: number;
}

export interface TaintReport {
  readonly paths: readonly TaintPath[];
  /** A bound stopped the search. A capped search finding nothing is not an exhaustive one. */
  readonly truncated: boolean;
  readonly analysedSymbols: number;
}

export interface IndexResult {
  score: number;
  loc: number;
  languages: LanguageStat[];
  graphStats: GraphStats;
  dimensions: DimensionScore[];
  /**
   * What the scan actually looked at (ADR-008).
   *
   * Optional so rows indexed before this existed keep deserialising — absent means "this run
   * predates coverage reporting", which the UI must render as unknown rather than as complete.
   */
  coverage?: ScanCoverage;
  /**
   * Wall-clock milliseconds per stage (HLD §14). Optional so rows written before this keep
   * deserialising — absent means "this run predates stage timing", not "it took no time".
   */
  stageTimings?: StageTimings;
  issues: Issue[];
  dependencies: string[]; // actual package names this repo depends on
  churnByFile: Record<string, number>;
  /**
   * Per-file organisational signals (§5.2). Optional: absent for runs from before they were
   * computed, and empty for a directory with no git history.
   */
  signals?: Record<string, FileSignals>;
  /**
   * Ownership, staleness and symbol-level attribution from git history.
   *
   * Optional for the reason `coverage`, `signals` and `incremental` above are: a row persisted
   * before this existed must keep deserialising, and ABSENT means "this run predates ownership
   * analysis", never "this repository has no owners". A directory that is not a git checkout
   * yields a present-but-empty report instead, so the two stay distinguishable.
   */
  ownership?: OwnershipReport;
  /**
   * APIs as graph entities, and the endpoint → service → sink flows traced from them.
   *
   * Optional on the same terms as `ownership` above: absent means the run predates the
   * analysis. A repository that simply has no HTTP surface gets a present report with empty
   * arrays, so "no endpoints" and "not analysed" stay distinguishable.
   */
  apiSurface?: ApiSurface;
  /**
   * Untrusted values that reach a dangerous sink, followed across call boundaries.
   *
   * Absent means not analysed. Present-and-empty means analysed and nothing found — and
   * `truncated` says whether a bound stopped the search, because a capped search that found
   * nothing is not the same claim as an exhaustive one.
   */
  taint?: TaintReport;
  /** Declared dependencies nothing imports. Candidates with a confidence, never verdicts. */
  unusedDependencies?: readonly UnusedDependency[];
  /**
   * Package names this repository's own manifests declare — what it PUBLISHES.
   *
   * Distinct from `dependencies`, which is what it consumes. Exists so the cross-repo graph
   * can draw an edge from manifest evidence: A depends on `P` and B declares `P`. Without it
   * the only way to link two repositories is to match a dependency against a slug, which
   * invents an edge whenever two names coincide.
   */
  packageNames?: readonly string[];
  tree: TreeNode;
  viz: VizGraph;
  modules: ModuleGraph;
  symbolGraph: SymbolGraph;
  /**
   * Reuse accounting for this run. Absent means the run predates incremental indexing.
   */
  incremental?: IncrementalReport;
  /**
   * Dependency vulnerability advisories for this run.
   *
   * Optional so rows written before this existed keep deserialising — and absent means
   * exactly "this run predates advisory lookup", NOT "no vulnerabilities". A run that did
   * look carries a report whose `status` says whether the answer is a measurement; see
   * `AdvisoryReport`.
   */
  advisories?: AdvisoryReport;
}

export const DIMENSION_META: Record<
  Dimension,
  { label: string; weight: number; color: string }
> = {
  correctness: { label: "Correctness", weight: 0.26, color: "#34d399" },
  security: { label: "Security", weight: 0.24, color: "#fb7185" },
  maintainability: { label: "Maintainability", weight: 0.22, color: "#a78bfa" },
  dependency_hygiene: { label: "Dependency hygiene", weight: 0.16, color: "#fbbf24" },
  test_integrity: { label: "Test integrity", weight: 0.12, color: "#22d3ee" },
};

/**
 * Pillars — three independent claims, reported side by side and NEVER averaged together
 * (PLAN.md §5.1).
 *
 * THE PROBLEM THIS FIXES. `overall` used to be `Σ dimension.score × weight` across all five
 * dimensions, so a codebase that was ugly but correct and one that was tidy but exploitable
 * could land on the same headline number. Blending "how likely is this to break" with "how
 * unpleasant is this to work in" answers neither question, and the second quietly discounts
 * the first: maintainability alone carried 0.22 of the headline, so 22% of what was presented
 * as risk was about tidiness.
 *
 * Defect risk is the surfaced number (IDENTITY.md §4.2 — 0-100, still the ONLY headline). The
 * other two are co-equal and separately reported: not sub-scores, not tie-breakers.
 *
 * WHAT THIS IS NOT. Splitting the pillars does not make the weights *correct* — they are the
 * same hand-picked constants, renormalised within each pillar. PLAN.md §5.3 is what replaces
 * them with constants fitted against a labelled defect corpus. This makes the score answer one
 * question instead of three; it does not yet make the answer calibrated.
 */
export type Pillar = "defect_risk" | "maintainability" | "performance_risk";

export const PILLAR_META: Record<
  Pillar,
  { label: string; surfaced: boolean; question: string }
> = {
  // The headline. `surfaced` is true for exactly one pillar, by design.
  defect_risk: {
    label: "Defect risk",
    surfaced: true,
    question: "How likely is this code to break?",
  },
  maintainability: {
    label: "Maintainability",
    surfaced: false,
    question: "How hard is this code to change?",
  },
  performance_risk: {
    label: "Performance risk",
    surfaced: false,
    question: "How likely is this code to be slow?",
  },
};

/**
 * Which pillar each dimension answers to.
 *
 * `performance_risk` has NO dimensions mapped to it today, and that is the honest state: no
 * rule in the analyser emits a performance finding, so there is nothing to score. It exists
 * here because `core-domain`'s v2 `Dimension` already includes `"performance"` and the two
 * models must reconcile (LLD §13.2) — this is the answer to that open question. Performance
 * does not take weight FROM the other dimensions, which is what made it unanswerable while
 * everything shared one blended total; it is its own pillar, currently unmeasured.
 */
export const DIMENSION_PILLAR: Record<Dimension, Pillar> = {
  correctness: "defect_risk",
  security: "defect_risk",
  dependency_hygiene: "defect_risk",
  test_integrity: "defect_risk",
  maintainability: "maintainability",
};

/**
 * A dimension's weight WITHIN its own pillar, renormalised so each pillar sums to 1.
 *
 * Derived from `DIMENSION_META` rather than written out again: a hardcoded copy is a second
 * set of numbers to keep in step, and the UI renders these as percentages, so drift between
 * them is drift in something a user reads.
 */
export function weightWithinPillar(dimension: Dimension): number {
  const pillar = DIMENSION_PILLAR[dimension];
  let total = 0;
  for (const d of Object.keys(DIMENSION_META) as Dimension[]) {
    if (DIMENSION_PILLAR[d] === pillar) total += DIMENSION_META[d].weight;
  }
  return total === 0 ? 0 : DIMENSION_META[dimension].weight / total;
}

/**
 * Aggregate scored dimensions into pillars.
 *
 * A PURE FUNCTION OF `dimensions`, and deliberately not a stored column. Pillars are entirely
 * determined by the dimension scores plus the static mapping above, so persisting them would
 * create a second copy that can disagree with the first — and a stored pillar that has drifted
 * from its own dimensions is a number nobody can debug. The UI and the scorer call this same
 * function on the same data instead.
 */
export function pillarsFrom(dimensions: DimensionScore[]): PillarScore[] {
  const byDimension = new Map(dimensions.map((d) => [d.dimension, d]));
  return (Object.keys(PILLAR_META) as Pillar[]).map((pillar) => {
    const members = (Object.keys(DIMENSION_META) as Dimension[]).filter(
      (d) => DIMENSION_PILLAR[d] === pillar,
    );
    // Nothing measured. Null, not 100 — see PillarScore.score.
    if (members.length === 0) return { pillar, score: null, dimensions: [], issueCount: 0 };
    const score = members.reduce(
      (sum, d) => sum + (byDimension.get(d)?.score ?? 0) * weightWithinPillar(d),
      0,
    );
    return {
      pillar,
      score: Math.round(score),
      dimensions: members,
      issueCount: members.reduce((sum, d) => sum + (byDimension.get(d)?.issueCount ?? 0), 0),
    };
  });
}

export interface PillarScore {
  pillar: Pillar;
  /**
   * 0-100, or NULL when the pillar has no dimensions to score.
   *
   * Null rather than 100. A pillar nothing was measured for is not a pillar that passed, and
   * rendering "Performance risk: 100" for "we ran no performance rules" is the exact shape of
   * claim this project keeps removing.
   */
  score: number | null;
  dimensions: Dimension[];
  issueCount: number;
}
