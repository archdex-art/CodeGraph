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
  tree: TreeNode;
  viz: VizGraph;
  modules: ModuleGraph;
  symbolGraph: SymbolGraph;
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
