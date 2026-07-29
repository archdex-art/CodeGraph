# CodeGraph — Low-Level Design (LLD)

| | |
|---|---|
| **Version** | 2.0 |
| **Status** | Proposed — implementation spec for [`HLD.md`](./HLD.md) |
| **Date** | 2026-07-29 |
| **Scope** | Package layout, module contracts, schema, error model, testing, migration map |
| **Governed by** | [`IDENTITY.md`](./IDENTITY.md) — binding on all user-facing names and models |

> Read [`HLD.md`](./HLD.md) first. This document is the "how", and assumes the "what" and
> "why" are settled. Every interface below is written to be pasted into the repo and
> compiled; types marked `// existing` already exist in v1 and carry forward.

---

## 1. Repository layout

Move from a single `app/` to an npm-workspaces monorepo. This is not ceremony — it is what
makes the dependency rule in HLD §6.1 mechanically enforceable rather than aspirational.

```
codegraph/
├── package.json                 # workspaces: ["apps/*", "packages/*"]
├── tsconfig.base.json           # strict:true, project references
├── .dependency-cruiser.cjs      # layering rules — CI gate
├── vitest.workspace.ts
├── apps/
│   ├── web/                     # Next.js. UI + API. No analysis code.
│   │   └── src/
│   │       ├── app/             # routes + pages (thin)
│   │       ├── components/      # existing components, unchanged in P1
│   │       └── server/          # composition root: wires packages → services
│   ├── worker/
│   │   └── src/
│   │       ├── main.ts          # poll loop, lease, signal handling
│   │       └── handlers/        # analyze.ts · fix.ts · timeline.ts
│   ├── cli/
│   └── desktop/                 # existing Electron app, brought under CI
├── packages/
│   ├── core-domain/
│   ├── core-graph/
│   ├── lang-typescript/
│   ├── lang-python/
│   ├── detect-engine/
│   ├── detect-rules/
│   ├── score-engine/
│   ├── remediate-engine/
│   ├── swarm/
│   ├── persistence/
│   ├── jobs/
│   ├── vcs/
│   ├── fsx/
│   ├── sarif/
│   ├── observability/
│   └── config/
├── benchmarks/                  # detection ground truth (see §11.4)
└── docs/
```

### 1.1 Package conventions (all packages)

```jsonc
// packages/<name>/package.json
{
  "name": "@codegraph/<name>",
  "type": "module",
  "exports": { ".": "./src/index.ts" },   // ONE public entry point
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

- `src/index.ts` is the **only** public surface. Deep imports (`@codegraph/x/src/internal/y`)
  are banned by lint. This is what lets internals be refactored without breaking callers.
- No package may have module-level mutable state. (Retires review item B4.)
- No package except `fsx`, `vcs`, `persistence` may import `node:fs`, `node:child_process`, or
  `node:sqlite`. Enforced by `no-restricted-imports`.

### 1.2 TypeScript baseline

```jsonc
// tsconfig.base.json — compilerOptions
{
  "strict": true,
  "noUncheckedIndexedAccess": true,     // catches the `arr[i]!` class of bug
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "composite": true                      // project references → incremental builds
}
```

`noUncheckedIndexedAccess` will surface real bugs in existing extractor code (`lines[i]`
patterns throughout `fixers.ts`/`extractors.ts`). Turn it on package-by-package during P1.

---

## 2. `@codegraph/core-domain`

Pure types and invariants. **Zero runtime dependencies.** Everything else speaks this
vocabulary.

```ts
// ---------- identity ----------
export type RepoId = Brand<string, "RepoId">;
export type RunId  = Brand<string, "RunId">;
export type JobId  = Brand<string, "JobId">;
export type SymbolId = Brand<string, "SymbolId">;
export type FindingId = Brand<string, "FindingId">;
type Brand<T, B> = T & { readonly __brand: B };

// ---------- location ----------
export interface SourceRange {
  readonly file: string;        // repo-relative, posix
  readonly startLine: number;   // 1-indexed
  readonly startCol: number;    // 1-indexed
  readonly endLine: number;
  readonly endCol: number;
}

// ---------- analysis tiers (HLD §8.3) ----------
export type AnalysisTier = "full" | "ast" | "lexical" | "skipped";

// ---------- findings ----------
export type Severity = 1 | 2 | 3 | 4 | 5;
export type Dimension =
  | "security" | "correctness" | "maintainability"
  | "test_integrity" | "dependency_hygiene" | "performance";

export interface DataflowStep {
  readonly range: SourceRange;
  readonly label: string;          // "source: req.body.name"
  readonly symbol: SymbolId | null;
}

export interface Evidence {
  /** Verbatim source of the offending range, trimmed. Never reconstructed. */
  readonly snippet: string;
  /** Why the engine believes this. Rendered in the UI verbatim. */
  readonly rationale: string;
  /** Ordered source→sink trace, when the rule is a dataflow rule. */
  readonly dataflow?: readonly DataflowStep[];
}

export type ConfidenceBasis =
  | "syntactic"            // pattern matched text
  | "structural"           // pattern matched AST shape
  | "type_verified"        // types confirm the shape
  | "dataflow_verified"    // a concrete source→sink path exists
  | "corroborated";        // multiple independent rules agree

export interface Finding {
  readonly id: FindingId;
  readonly runId: RunId;
  readonly ruleId: string;             // "js/sql-injection"
  readonly range: SourceRange;
  readonly symbol: SymbolId | null;
  readonly severity: Severity;
  readonly confidence: number;         // 0..1
  readonly confidenceBasis: ConfidenceBasis;
  readonly dimension: Dimension;
  readonly title: string;
  readonly evidence: Evidence;
  readonly blastRadius: number;        // symbol-level reachable callers
  readonly churn: number;
  readonly analysisTier: AnalysisTier; // tier of the file it came from
  /** Location-independent identity. Survives file moves and line shifts. */
  readonly fingerprint: string;
}

// ---------- runs ----------
export interface AnalysisCoverage {
  readonly totalFiles: number;
  readonly byTier: Readonly<Record<AnalysisTier, number>>;
  readonly locAtAstOrBetter: number;
  readonly totalLoc: number;
  /** locAtAstOrBetter / totalLoc — published next to the score (ADR-008). */
  readonly ratio: number;
}

export interface StageTiming {
  readonly stage: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly degraded?: string;   // "parse budget exhausted at 3412/8900 files"
}

export interface AnalysisRun {
  readonly id: RunId;
  readonly repoId: RepoId;
  readonly commitSha: string | null;
  readonly engineVersion: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly coverage: AnalysisCoverage;
  readonly timings: readonly StageTiming[];
}
```

### 2.1 Fingerprints — a two-factor hash, not a utility function

This is a core algorithm, not a helper. It is the single function every downstream identity
guarantee — suppression, baselines, "new since main", trend lines — inherits its correctness
from, and the single-hash version shipped in v1 is already wrong in production: the P1
findings-backfill (`docs/REVIEW_2026-07-29.md` P1-8) found real repos where every occurrence of
one rule in one file collapsed onto the same fingerprint, because v1 hashed `(ruleId, file)`
with no snippet at all. Two independent findings became one. A two-factor design is the fix, not
an enhancement.

**Why one hash cannot work.** A hash needs to be *insensitive* to churn that doesn't change the
finding (reformatting, unrelated edits above it) and *sensitive* to churn that does (the
vulnerable code moving to a different function). Those pull in opposite directions, and no
single normalisation gets both right: normalise away identifiers and unrelated `if (x) return
null;` statements across the whole repo collide; keep identifiers and a harmless rename creates
a phantom "new" finding next to a phantom "resolved" one.

```ts
/**
 * Location-independent finding identity (HLD §11.2). Two independent hashes,
 * resolved by an explicit precedence rule below — never merged into one.
 */
export interface FingerprintInput {
  readonly ruleId: string;
  /** Enclosing symbol's fully-qualified name, or the file's basename if none.
   *  Read from `Sym.qualifiedName` (core-graph §3) — this ties fingerprint
   *  identity to symbol identity instead of duplicating name resolution. */
  readonly scope: string;
  /** The matched source, normalised: whitespace collapsed, string/number
   *  literals replaced by placeholders, identifiers preserved. */
  readonly normalizedSnippet: string;
  /** AST-structural shape of the matched node and its immediate parent chain
   *  up to the containing statement: node *types* only (CallExpression,
   *  BinaryExpression, ...), no identifiers, no literals. Two occurrences of
   *  `if (x) return null;` with different variable names produce the same
   *  structuralHash — that collision is intentional here; §2.1.1 is what
   *  prevents it from merging unrelated findings. */
  readonly structuralHash: string;
}

export interface Fingerprint {
  readonly primary: string;    // sha256(ruleId, scope, structuralHash) — the identity anchor
  readonly secondary: string;  // sha256(ruleId, scope, normalizedSnippet) — the exact match
}

export function fingerprint(input: FingerprintInput): Fingerprint;
```

`scope` is included in **both** hashes and is never dropped from either. This is what stops
`structuralHash` from merging unrelated findings — the reviewer's concrete failure mode for a
bare structural hash: every `if (x) return null;` in the repo has the same `structuralHash`, but
only the ones inside the *same enclosing symbol* as a prior finding are candidates for identity
resolution. `structuralHash` narrows "is this the same code, restructured or renamed"; `scope`
narrows "is this even the same place."

#### 2.1.1 Resolution: matching a new run against the prior baseline

```
match(newFinding, priorBaseline):
  exact    = priorBaseline.find(p => p.secondary == newFinding.secondary)
  if exact: return { same: exact, reason: "unchanged" }

  moved    = priorBaseline.find(p => p.primary == newFinding.primary
                                  && p.secondary != newFinding.secondary)
  if moved: return { same: moved, reason: "renamed-or-reformatted-in-place" }
           # primary matched (same rule, same scope, same AST shape) but the
           # snippet text changed — a variable rename or an added-but-inert
           # parameter, not a new vulnerability. Carry the finding's identity
           # forward; do NOT reset its "first seen" date.

  return { same: null, reason: "new" }
```

A finding with no `moved` or `exact` match is reported new. A prior finding with no match in the
new run is reported resolved. This is a heuristic, stated as one: `primary` matching does not
*prove* the two occurrences are the same vulnerability — it proves they are the same rule, in
the same scope, with the same code shape, which is the strongest signal available without
re-running the taint solver on both commits to compare paths. Two genuinely different bugs that
happen to share rule, scope, and AST shape (e.g. two different `eval()` calls added to the same
function in one commit) will incorrectly resolve to one identity. Documented as a known
false-negative on "new findings," not silently accepted — the failure mode is *undercounting*
new findings in this narrow case, never inventing findings that don't exist, and never merging
findings from different scopes or different rules.

`structuralHash` is computed once per matched node during the same AST walk `normalizedSnippet`
already requires (core-graph §3.1 traversal) — no second pass, no meaningful runtime cost.

---

## 3. `@codegraph/core-graph`

The program graph and its query surface. Replaces `src/lib/codeintel/{graph,query}.ts`.

```ts
export type SymbolKind =
  | "function" | "method" | "class" | "interface"
  | "component" | "variable" | "type" | "module";

export interface Sym {
  readonly id: SymbolId;
  readonly name: string;
  readonly qualifiedName: string;      // "src/lib/auth.ts::AuthService.verify"
  readonly kind: SymbolKind;
  readonly range: SourceRange;
  readonly signature: string;
  readonly doc: string | null;
  readonly exported: boolean;
  readonly container: SymbolId | null;
  readonly metrics: SymbolMetrics;
}

export interface SymbolMetrics {
  readonly loc: number;
  readonly cyclomatic: number;
  readonly cognitive: number;          // Campbell's cognitive complexity
  readonly maxNesting: number;
  readonly params: number;
}

export type EdgeKind = "calls" | "imports" | "extends" | "implements" | "references";
export interface Edge {
  readonly from: SymbolId;
  readonly to: SymbolId;
  readonly kind: EdgeKind;
  readonly at: SourceRange;
  readonly resolution: "exact" | "heuristic" | "dynamic";
}
```

### 3.1 Control-flow graph (new in v2 — precondition for dataflow)

```ts
export interface CfgNode {
  readonly id: string;
  readonly kind: "entry" | "exit" | "statement" | "branch" | "loop" | "call" | "throw";
  readonly range: SourceRange;
}
export interface CfgEdge {
  readonly from: string;
  readonly to: string;
  readonly label: "true" | "false" | "seq" | "exception" | "back";
}
/** One CFG per callable. Built lazily and cached per symbol. */
export interface Cfg {
  readonly symbol: SymbolId;
  readonly nodes: readonly CfgNode[];
  readonly edges: readonly CfgEdge[];
  readonly entry: string;
  readonly exits: readonly string[];
}
```

### 3.1.1 SSA form and def-use chains — precondition for L4, not optional

DETECTION_ENGINE.md §4.5's taint solver pseudocode says `propagate along def-use`. A `Cfg` alone
cannot answer "which definition of `x` reaches this use" — it sees statements, not variable
versions, so `x = 1; if (cond) x = tainted(); sink(x);` has no way to distinguish "the tainted
definition reaches the sink through the true branch" from "the safe definition always reaches
it." Without this, a worklist dataflow over a bare CFG either treats every reassignment as
conservatively tainting the whole variable for its rest of scope (false positives at every
branch merge) or ignores branches entirely (false negatives). Both are the specific failure mode
DETECTION_ENGINE.md §4.5 warns against generally — unmodelled dataflow "produces more noise than
signal, and noise is what gets a scanner switched off."

SSA (static single assignment) is the standard fix, and it is explicitly pre-approved technique
per IDENTITY.md §3 ("Def-use chains and SSA... that vocabulary is decades old and belongs to the
field, not to any vendor").
Every reassignment gets a fresh version; control-flow merges get an explicit φ (phi) node that
picks the version per incoming edge. `DefUseChain` is then a direct lookup, not a graph walk.

```ts
export interface SsaVersion {
  readonly variable: string;
  readonly version: number;          // x_0, x_1, x_2…
  readonly definedAt: CfgNode["id"];
  /** null only for the implicit version 0 of a function parameter. */
  readonly definingExpr: string | null;
}

/** A branch merge point where the reaching definition of a variable depends on
 *  which predecessor edge was taken. Synthetic — has no `SourceRange`. */
export interface PhiNode {
  readonly id: string;
  readonly at: CfgNode["id"];        // the merge point (loop header, post-if, etc.)
  readonly variable: string;
  readonly result: SsaVersion;
  /** One source version per incoming CFG edge, in `Cfg.edges` order. */
  readonly operands: readonly SsaVersion[];
}

/** One version's complete reach: everywhere it is read before being
 *  redefined. This *is* the def-use chain — a lookup table, not a traversal,
 *  which is what makes `solveLocal`'s `propagate along def-use` step O(uses)
 *  instead of a re-walk of the CFG per definition. */
export interface DefUseChain {
  readonly def: SsaVersion;
  readonly uses: readonly CfgNode["id"][];
}

/** Built once per `Cfg`, lazily, cached alongside it — the standard
 *  CFG→SSA construction (dominance frontiers → φ placement → renaming). Not
 *  reproduced here; it is a well-known algorithm, not a design decision. */
export interface SsaForm {
  readonly cfg: Cfg;
  readonly versions: readonly SsaVersion[];
  readonly phis: readonly PhiNode[];
  readonly chains: readonly DefUseChain[];
}

export function toSsa(cfg: Cfg): SsaForm;
```

`solveLocal` (DETECTION_ENGINE.md §4.5) runs over `SsaForm`, not `Cfg` directly: taint attaches
to an `SsaVersion`, not a variable name, so `x = 1; if (cond) x = tainted();` produces two
distinct versions of `x` and the sink after the merge reads through the φ node to see that only
one incoming operand is tainted — the source of both the reduced false-positive rate over v1's
string-matching and the reduced false-negative rate over a bare-CFG worklist. This is the one
piece of `core-graph` allowed to be CPU-heavier than the rest of the package: it runs once per
`full`-tier symbol that a taint rule actually reaches, not on every symbol at index time — see
DETECTION_ENGINE.md §4.9 for the gate that keeps it off the hot path.

### 3.2 Query surface

```ts
export interface ProgramGraph {
  symbol(id: SymbolId): Sym | undefined;
  symbolAt(file: string, line: number): Sym | undefined;
  callers(id: SymbolId): readonly Sym[];
  callees(id: SymbolId): readonly Sym[];

  /** Transitive callers up to `maxHops`, with hop counts. THE correct blast
   *  radius source — replaces v1's file-level import fan-in (review B2). */
  reachableCallers(id: SymbolId, maxHops: number): readonly { symbol: Sym; hops: number }[];
  reachableCallees(id: SymbolId, maxHops: number): readonly { symbol: Sym; hops: number }[];

  /** Strongly-connected components with size > 1 — real cycles, via Tarjan.
   *  v1 caps at 15 arbitrarily; v2 returns all and lets the caller rank. */
  cycles(): readonly (readonly SymbolId[])[];

  /** Symbols with no resolved callers, excluding declared entrypoints,
   *  exported API surface, and anything reachable from a framework convention. */
  unreferenced(opts: { treatExportsAsRoots: boolean }): readonly Sym[];

  cfg(id: SymbolId): Cfg | undefined;
}
```

### 3.3 Blast radius (fixes review B2)

```ts
/**
 * v1: blastRadius = 1 + importFanIn(file)  — one number per FILE, applied to
 *     every issue in it. A TODO in a hot file outranked an eval() in a leaf.
 * v2: symbol-scoped, hop-damped, and capped.
 */
export function blastRadius(g: ProgramGraph, sym: SymbolId | null, file: string): number {
  if (!sym) return fileLevelFallback(g, file);      // damped, capped at 8
  const reach = g.reachableCallers(sym, 4);
  // Each hop away contributes less: direct callers count 1, 2-hop 1/2, 3-hop 1/3…
  return 1 + reach.reduce((acc, r) => acc + 1 / r.hops, 0);
}
```

---

## 4. `@codegraph/lang-*` — language plugins

A language package knows about *its* syntax and nothing about detection, scoring, or storage.

```ts
export interface LanguagePlugin {
  readonly id: string;                       // "typescript"
  readonly extensions: readonly string[];
  /** Best tier this plugin can reach given the host environment. */
  capabilities(): { maxTier: AnalysisTier; needsProject: boolean };

  /** Stage 3+4 of the pipeline, fused: parse then extract, per file. PURE. */
  analyzeFile(input: FileInput, tier: AnalysisTier): FileFacts;

  /** Build a CFG for one callable. Optional — absence caps rules at `structural`. */
  buildCfg?(facts: FileFacts, symbolLocalId: string): Cfg | undefined;

  /** tree-sitter-style query support, enabling data-defined rules (§6.2). */
  query?(facts: FileFacts, pattern: string): readonly SourceRange[];
}

export interface FileInput {
  readonly path: string;          // repo-relative posix
  readonly text: string;
  readonly contentHash: string;   // sha256 — the cache key
}

/** The cacheable unit (HLD §8.2). Small, structured, serialisable. */
export interface FileFacts {
  readonly path: string;
  readonly contentHash: string;
  readonly language: string;
  readonly tier: AnalysisTier;
  readonly extractorVersion: string;    // bump invalidates cache
  readonly loc: number;
  readonly symbols: readonly RawSymbol[];
  readonly references: readonly RawReference[];
  readonly imports: readonly RawImport[];
  /** Normalised AST node index for rule matching — see §6.1. */
  readonly nodes: readonly AstNode[];
}
```

`RawSymbol` / `RawReference` / `RawImport` carry forward from v1's `extractors.ts` — that
interface was already correctly shaped and is the best-designed seam in the current codebase.

### 4.1 Registry

```ts
// packages/detect-engine/src/languages.ts
const registry = new Map<string, LanguagePlugin>();
export function registerLanguage(p: LanguagePlugin): void;
export function pluginFor(ext: string): LanguagePlugin | undefined;
```

Registration happens once in the composition root (`apps/worker/src/main.ts`). **The engine
never names a language.** Adding Go = write `lang-go`, add one `registerLanguage(goPlugin)`
line. That is goal G3, made concrete.

---

## 5. `@codegraph/detect-engine`

The replacement for v1's `RULES` array in `indexer.ts`. Full rationale in
[`DETECTION_ENGINE.md`](./DETECTION_ENGINE.md); this section is the code shape.

### 5.1 Rule model

```ts
export type RuleKind = "syntactic" | "structural" | "metric" | "dataflow" | "project";

export interface RuleMeta {
  readonly id: string;                  // "js/sql-injection"
  readonly name: string;
  readonly dimension: Dimension;
  readonly baseSeverity: Severity;
  readonly kind: RuleKind;
  readonly languages: readonly string[];
  readonly cwe?: readonly string[];     // ["CWE-89"]
  readonly owasp?: readonly string[];
  /** Minimum tier at which this rule may fire. A dataflow rule must not
   *  emit from a `lexical` file — this is enforced, not advisory. */
  readonly minTier: AnalysisTier;
  readonly help: { text: string; uri?: string };
  /** Estimated remediation effort in minutes — feeds the debt model (§7.2). */
  readonly remediationMinutes: number;
}

export interface Rule {
  readonly meta: RuleMeta;
  run(ctx: RuleContext): readonly RuleMatch[];
}

export interface RuleContext {
  readonly facts: FileFacts;            // for per-file rules
  readonly graph: ProgramGraph;         // for whole-program rules
  readonly project: ProjectFacts;       // manifests, lockfiles, CI config, test layout
  readonly taint: TaintSolver;          // §5.3
  readonly signal: AbortSignal;
}

export interface RuleMatch {
  readonly range: SourceRange;
  readonly symbol: SymbolId | null;
  readonly severityDelta?: number;      // e.g. +1 when dataflow-confirmed
  readonly confidenceBasis: ConfidenceBasis;
  readonly evidence: Evidence;
  readonly messageArgs?: Readonly<Record<string, string>>;
}
```

**Why `minTier` is enforced, not advisory:** it is the mechanism that stops v2 from repeating
v1's central error — reporting a low-evidence regex hit with the same visual weight as a
graph-verified taint path. A `lexical`-tier file cannot produce a `dataflow_verified` finding,
by construction.

### 5.2 Engine

```ts
export interface DetectOptions {
  readonly ruleFilter?: (m: RuleMeta) => boolean;
  readonly budgetMs: number;
  readonly maxFindingsPerRule: number;   // damped, not hard-capped — see §7.1
}

export class DetectEngine {
  constructor(private readonly rules: readonly Rule[]) {}
  detect(input: DetectInput, opts: DetectOptions): DetectResult;
}

export interface DetectResult {
  readonly findings: readonly Finding[];
  readonly ruleStats: readonly { ruleId: string; matches: number; ms: number }[];
  readonly degradations: readonly string[];
}
```

Per-rule timing in `ruleStats` is not a nicety: it is how a pathological rule gets found and
budgeted out instead of making the whole run slow for unknown reasons.

### 5.3 Taint solver

```ts
export interface TaintSpec {
  readonly sources: readonly PatternSpec[];
  readonly sanitizers: readonly PatternSpec[];
  readonly propagators: readonly PatternSpec[];
  readonly sinks: readonly PatternSpec[];
}

export interface TaintSolver {
  /** Intraprocedural: within one callable's CFG. Available at tier >= ast. */
  solveLocal(sym: SymbolId, spec: TaintSpec): readonly TaintPath[];
  /** Interprocedural: across resolved call edges, bounded depth.
   *  Available at tier >= ast with `exact` call resolution. */
  solveGlobal(spec: TaintSpec, maxDepth: number): readonly TaintPath[];
}

export interface TaintPath {
  readonly source: DataflowStep;
  readonly steps: readonly DataflowStep[];
  readonly sink: DataflowStep;
  readonly sanitized: boolean;
  readonly crossesFunctions: number;
}
```

The `sanitizers` concept is the piece v1's `taintFindings` lacks entirely, and it is the single
biggest false-positive source in any taint analysis: without it, correctly-sanitised code is
reported as vulnerable, which is exactly the noise that makes developers switch a scanner off.

### 5.3.1 Cache invalidation matrix — and why it is gated on resolution quality

Every layer above the raw AST is a cache: `Cfg` per symbol (§3.1), `SsaForm` per symbol (§3.1.1),
`solveGlobal`'s per-function taint summaries (§5.3), and P5's planned content-addressed
incremental cache (HLD §17) all sit on top of `Edge.resolution` (core-graph §3). None of them are
correct if invalidation stops at the file that changed.

| Layer | Keyed by | Invalidated when | Must also invalidate |
|---|---|---|---|
| `Cfg` | `SymbolId` | that symbol's source range changes | its `SsaForm` (derived) |
| `SsaForm` | `SymbolId` | its `Cfg` is invalidated | any `solveLocal` result computed from it |
| Local taint result | `SymbolId` | its `SsaForm` is invalidated | any `solveGlobal` summary that consumed it |
| Interprocedural summary | `SymbolId` | any **callee reachable via a `resolution: "exact"` edge** changes its own summary | every summary that transitively calls this one — the reverse-dependency walk below |
| Finding | `Fingerprint.primary` | its symbol's `structuralHash` changes (§2.1) | nothing further — findings are leaves |

```ts
/** file changed → symbols in it invalidated → walk callers via resolved
 *  "calls" edges → invalidate every reachable summary, transitively. */
function invalidate(g: ProgramGraph, changedFile: string): Set<SymbolId> {
  const dirty = new Set(g.symbolsInFile(changedFile).map((s) => s.id));
  const frontier = [...dirty];
  while (frontier.length) {
    const id = frontier.pop()!;
    // Only exact edges propagate a summary invalidation — a heuristic or
    // dynamic caller *might* be affected, but re-running speculatively on
    // every possible caller defeats the point of an incremental cache.
    for (const caller of g.callers(id)) {
      if (dirty.has(caller.id)) continue;
      dirty.add(caller.id);
      frontier.push(caller.id);
    }
  }
  return dirty;
}
```

**This is where cache correctness stops being a caching problem and becomes an `Edge.resolution`
problem.** `invalidate` only walks edges the graph actually resolved. Measured on
`expressjs/express` post-P1 (`docs/REVIEW_2026-07-29.md`, 2026-07-29 remediation pass): the
extractor currently resolves **11 call edges across 123 symbols** — a caller that the graph
failed to resolve is invisible to this walk, so its cached summary goes stale silently instead of
being invalidated. A cache with unsound invalidation is worse than no cache: it serves a finding
that looks current and isn't.

**Consequence for phased delivery:** P5 ("scale & incrementality" — content-addressed cache,
HLD §17) cannot be built correctly on P3's call-resolution quality as it stands today. This is
recorded as an explicit phase dependency in HLD §17, not left implicit. Shipping the cache before
resolution is fixed would need every summary to be invalidated on *any* change to its file's
direct neighbourhood (imports in, imports out) rather than the precise reverse-call-graph above —
correct, but reduces to file-level invalidation and gives up most of the incrementality P5 exists
to deliver. That fallback is an acceptable interim if P5 ships before resolution quality
improves further; it is not acceptable as the permanent design.

### 5.4 Rules as data (`@codegraph/detect-rules`)

Most rules should be YAML, not TypeScript, so contributing one requires no engine knowledge.

Rules describe **graph shapes** in CodeGraph's own vocabulary — the same nouns the Code
Intelligence tab exposes (`call`, `callee`, `caller`, `symbol`, `member`, `argument`,
`resolvesTo`, `reachableFrom`). A rule therefore reads like a question you could have asked the
graph by clicking, and anything it finds is something you can go look at in the graph views.

```yaml
# packages/detect-rules/rules/js/sql-injection.yaml
id: js/sql-injection
name: SQL query built from untrusted input
dimension: security
baseSeverity: 5
kind: dataflow
languages: [javascript, typescript]
minTier: ast
cwe: [CWE-89]
remediationMinutes: 30

taint:
  sources:
    # "a member read off a parameter whose shape says it's a request object"
    - member: [body, query, params, headers]
      of: { param: { shapeHint: request } }

  sanitizers:
    - call: { callee: { name: [escape, escapeId, parseInt, Number] } }
    - call: { callee: { member: escape } }

  sinks:
    - call:
        callee: { member: [query, execute, raw] }
        argument:
          index: 0
          is: [template_literal, string_concat]   # a parameterised call is not a sink

message: >
  {{source.name}} flows into a SQL query at {{sink.symbol}} without sanitisation.
help:
  text: Use parameterised queries. Never build SQL by concatenating input.
  uri: https://owasp.org/www-community/attacks/SQL_Injection
```

Note what the vocabulary buys: `is: [template_literal, string_concat]` on the sink argument
means a correctly parameterised `db.query(sql, [id])` is *structurally* not a sink, so it can
never be reported — the false positive is designed out rather than filtered later.

A TypeScript `Rule` remains available for anything the schema cannot express (metric rules,
project-level rules). The declarative form exists to make the common case cheap, not to be
universal.

> **Not adopted:** a code-shaped pattern syntax with metavariables. See
> [`IDENTITY.md`](./IDENTITY.md) §4.1 and `DETECTION_ENGINE.md` §4.4 for why.

---

## 6. `@codegraph/score-engine`

Pure. No I/O. Given findings + graph + coverage, produce a health report.

```ts
export interface ScoreInput {
  readonly findings: readonly Finding[];
  readonly loc: number;
  readonly coverage: AnalysisCoverage;
  readonly model: ScoreModel;
}

export interface ScoreModel {
  readonly version: string;              // "2.0" — persisted with every run
  readonly dimensionWeights: Readonly<Record<Dimension, number>>;
  readonly k: number;
  readonly blastRadiusCap: number;
  readonly volumeDamping: "log" | "sqrt" | "none";
}

export interface HealthReport {
  readonly overall: number;              // 0..100
  readonly dimensions: readonly DimensionScore[];
  readonly coverage: AnalysisCoverage;   // ALWAYS reported alongside (ADR-008)
  readonly modelVersion: string;
  readonly technicalDebtMinutes: number;
  readonly debtRatio: number;
}
```

### 6.1 Penalty aggregation (fixes review B3)

```ts
/**
 * v1: hits capped at 5 per rule per file → 500 console.logs scored as 5,
 *     and the fixer could delete 400 of them for zero score movement.
 * v2: damped, not capped — volume registers with diminishing returns.
 */
function rulePenalty(matches: readonly Finding[], model: ScoreModel): number {
  const unit = matches.reduce(
    (a, f) => a + f.severity * Math.min(f.blastRadius, model.blastRadiusCap) * f.confidence,
    0,
  );
  const n = matches.length;
  switch (model.volumeDamping) {
    case "log":  return (unit / n) * (1 + Math.log2(1 + n));
    case "sqrt": return (unit / n) * Math.sqrt(n);
    default:     return unit;
  }
}
```

Multiplying by `confidence` is new and important: a `syntactic` guess should not push the score
as hard as a `dataflow_verified` fact. v1 stores `confidence` on issues and then ignores it in
`score()`.

### 6.2 Projection (fixes review C5)

```ts
/**
 * v1: projected = current + (P0*2.2 + P1*1.1) — a linear guess against an
 *     exponential model. It was arithmetic, presented as a forecast.
 * v2: actually re-run the model with the selected findings removed.
 */
export function projectScore(
  input: ScoreInput,
  resolvedFindingIds: ReadonlySet<FindingId>,
): HealthReport {
  return computeScore({
    ...input,
    findings: input.findings.filter((f) => !resolvedFindingIds.has(f.id)),
  });
}
```

Once findings are rows and scoring is a pure function, the honest version costs one function
call. There is no reason to keep the guess.

### 6.3 Remediation effort

`technicalDebtMinutes` is the sum of each open finding's `remediationMinutes`, and `debtRatio`
normalises it against development cost (`locCost × loc`, default 30 min/LOC) so a large codebase
isn't penalised for being large. The normalisation approach is standard; see
`DETECTION_ENGINE.md` §3.4.

This is **supporting detail, not a second score.** It renders as a column and a hover — *"about
6 hours of work"* — because effort in hours is something a non-engineer can act on.

> **The Health Score is the headline metric and it stands alone.** No letter grade, no A–E
> ladder, no pass/fail badge derived from `debtRatio`. Putting a second grade next to the score
> forces a reader to choose which number to believe, and the borrowed one would win by
> familiarity. [`IDENTITY.md`](./IDENTITY.md) §4.2.

---

## 7. `@codegraph/remediate-engine`

### 7.1 Fix providers (fixes review C1, C2)

```ts
export interface FixProvider {
  readonly id: string;
  /** Which rules this provider can fix. THE binding v1 lacks entirely. */
  readonly handles: readonly string[];    // ["js/no-debug-output"]
  readonly languages: readonly string[];
  readonly safety: "syntactic" | "semantic" | "risky";

  /** Produce an edit for ONE finding. Never repo-wide. */
  propose(finding: Finding, ctx: FixContext): FixCandidate | null;
}

export interface FixContext {
  readonly facts: FileFacts;     // AST available — fixes are AST edits, not line edits
  readonly graph: ProgramGraph;
  readonly readFile: (p: string) => string;
}

export interface FixCandidate {
  readonly findingId: FindingId;
  readonly providerId: string;
  readonly edits: readonly TextEdit[];    // range-based, not line-based
  readonly explanation: string;
  readonly confidence: number;
}

export interface TextEdit {
  readonly file: string;
  readonly range: SourceRange;   // replace this range…
  readonly newText: string;      // …with this
}
```

`TextEdit` being **range-based** rather than line-based is what structurally prevents review
bug B1: an AST-derived range for a `console.log` statement inside a brace-less `if` includes
the statement, and the AST knows the `if` then has an empty consequent — so the provider either
emits `if (x) {}`… or, correctly, declines. A line-deleting fixer cannot know this.

### 7.2 Verification (fixes review C3 — the four gates)

```ts
export type VerificationGate = "syntax" | "types" | "tests" | "reanalysis";

export interface GateResult {
  readonly gate: VerificationGate;
  readonly status: "passed" | "failed" | "skipped";
  readonly reason?: string;      // "no test script in package.json"
  readonly ms: number;
  readonly log?: string;         // truncated, credential-redacted
}

export interface VerificationRecord {
  readonly candidateId: string;
  readonly gates: readonly GateResult[];
  /** TRUE only if no gate failed AND at least `syntax` + `reanalysis` ran. */
  readonly verified: boolean;
  /** "full" = tests ran and passed. "partial" = no suite to run. */
  readonly level: "full" | "partial" | "none";
}

export interface Verifier {
  verify(candidate: FixCandidate, sandbox: SandboxHandle): Promise<VerificationRecord>;
}
```

Gate implementations:

| Gate | Implementation | Skip condition |
|---|---|---|
| `syntax` | Re-parse the edited file with the language plugin; zero parse errors | never skipped |
| `types` | `tsc --noEmit` / `mypy` if the project is configured for it | no type config present |
| `tests` | Detect runner from manifest → run in a locked-down container, network off, timeboxed, resource-capped | no test script, or `CG_ALLOW_TEST_VERIFICATION` unset |
| `reanalysis` | Re-run detection on the patched tree; the **target finding's fingerprint** must be gone and no new finding introduced | never skipped |

Note gate 4 checks the *specific fingerprint*, not the aggregate score. "The score went up" is
not evidence that *this* finding was fixed — v1 conflates the two.

### 7.3 Publishing (fixes review C4)

```ts
export interface PublishRequest {
  readonly runId: RunId;
  readonly candidateIds: readonly string[];
  /** Must be true. The API rejects a publish without it. */
  readonly confirmed: true;
  readonly branchName?: string;
}
```

`vcs` resolves the real default branch via `GET /repos/{o}/{r}` (fixes the hardcoded
`base: "main"`), checks `response.ok` on every GitHub call, and takes its token **only** from
the session — never from a request body (fixes B8).

---

## 8. `@codegraph/persistence`

The only module that writes SQL. Everything above it sees repository interfaces.

```ts
export interface RepoRepository {
  create(input: NewRepo): RepoId;
  byId(id: RepoId, viewer: ViewerId): Repo | null;         // viewer is MANDATORY
  list(viewer: ViewerId, page: Page): Paged<RepoSummary>;
  delete(id: RepoId, viewer: ViewerId): boolean;
}

export interface FindingRepository {
  bulkInsert(runId: RunId, findings: readonly Finding[]): void;
  query(runId: RunId, filter: FindingFilter, page: Page): Paged<Finding>;
  countByDimension(runId: RunId): Record<Dimension, number>;
  /** Findings in `runId` whose fingerprint is absent from `baseRunId`. */
  newSince(runId: RunId, baseRunId: RunId): readonly Finding[];
  setStatus(id: FindingId, status: FindingStatus, viewer: ViewerId): void;
}
```

**Tenant isolation is a type-level obligation.** Every read takes `ViewerId`. There is no
overload without it, so a route cannot forget one. (v1 relies on each route remembering to call
`repoAccessDenied` — correct today, one new route away from a leak.)

### 8.1 Target schema

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'git',
  owner_id INTEGER,                      -- NULL = public bucket (unchanged semantics)
  workspace_dir TEXT,
  default_branch TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_repos_owner ON repos(owner_id, created_at DESC);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT,
  engine_version TEXT NOT NULL,
  score_model_version TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  loc INTEGER,
  coverage_json TEXT NOT NULL,
  timings_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_runs_repo ON runs(repo_id, started_at DESC);
CREATE UNIQUE INDEX idx_runs_idem ON runs(repo_id, commit_sha, engine_version)
  WHERE commit_sha IS NOT NULL;          -- idempotency (HLD §10)

-- Findings are ROWS, not a JSON blob (HLD §11.2).
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  dimension TEXT NOT NULL,
  severity INTEGER NOT NULL,
  confidence REAL NOT NULL,
  confidence_basis TEXT NOT NULL,
  analysis_tier TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL, start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,   end_col INTEGER NOT NULL,
  symbol_id TEXT,
  blast_radius REAL NOT NULL,
  churn INTEGER NOT NULL DEFAULT 1,
  score REAL, priority TEXT,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'    -- open | fixed | dismissed | suppressed
);
CREATE INDEX idx_findings_run      ON findings(run_id, priority, score DESC);
CREATE INDEX idx_findings_fp       ON findings(fingerprint);
CREATE INDEX idx_findings_run_dim  ON findings(run_id, dimension, severity);

-- Suppressions survive runs by fingerprint, not by id.
CREATE TABLE suppressions (
  repo_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  reason TEXT, created_by INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, fingerprint)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- analyze | fix | timeline
  repo_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,                  -- queued|leased|running|succeeded|failed|cancelled
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_until INTEGER,
  worker_id TEXT,
  progress INTEGER DEFAULT 0,
  stage TEXT,
  error TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs(status, priority DESC, created_at);
CREATE UNIQUE INDEX idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Large artifacts live on disk; the row is a pointer.
CREATE TABLE blobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- graph|viz|sarif|diff|cfg
  path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_blobs_run_kind ON blobs(run_id, kind);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
```

### 8.2 Migrations

Replace v1's ad-hoc `if (!cols.has("x")) ALTER TABLE` chain in `db.ts` with a numbered,
forward-only runner. The v1 approach worked but is unauditable and cannot express data
migrations (only schema ones), which the findings-blob → findings-rows move requires.

```ts
export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Database): void;     // runs inside a transaction
}
```

Rules: sequential, never edited after release, always transactional, and the runner takes a
file copy of the SQLite DB before applying anything when `CG_MIGRATION_BACKUP=1`.

`004_findings_to_rows.ts` reads each `repos.issues` JSON blob, synthesises a historical run,
inserts rows, and leaves the old column in place until `007_drop_legacy_columns.ts` — so a
rollback is possible for two releases.

### 8.3 Job claim query

```sql
UPDATE jobs SET status='leased', worker_id=?, lease_until=?, attempts=attempts+1, updated_at=?
WHERE id = (
  SELECT id FROM jobs
  WHERE (status='queued')
     OR (status='leased' AND lease_until < ?)          -- reclaim orphans
  ORDER BY priority DESC, created_at ASC LIMIT 1
)
RETURNING *;
```

Atomic under WAL. The orphan-reclaim clause is what makes worker crashes recoverable without a
separate reaper.

---

## 9. HTTP layer conventions (`apps/web`)

Routes become uniformly thin. Every route is the same five lines:

```ts
export const POST = route({
  body: z.object({ repoUrl: z.string().url() }),
  rateLimit: { bucket: "runs", capacity: 10, windowMs: 60_000 },
  auth: "optional",
  handler: async ({ body, viewer, services }) => {
    const runId = await services.analysis.enqueue(body.repoUrl, viewer);
    return created({ runId });
  },
});
```

The `route()` helper owns: zod validation, rate limiting, auth resolution, error → HTTP
mapping, request-id propagation, and structured access logging. **This is what closes review
B6** — a route physically cannot skip the rate limiter, because the limiter is part of the
route constructor rather than a line each handler remembers to write.

### 9.1 Error model

```ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,          // machine-readable, stable
    readonly httpStatus: number,
    message: string,                   // safe for the user
    readonly context?: Record<string, unknown>,  // logged, never returned
    readonly cause?: unknown,
  ) { super(message); }
}

export type ErrorCode =
  | "REPO_NOT_FOUND" | "REPO_NOT_INDEXED" | "ACCESS_DENIED"
  | "INVALID_URL" | "SSRF_BLOCKED" | "RATE_LIMITED"
  | "JOB_FAILED" | "VERIFICATION_FAILED" | "BUDGET_EXCEEDED"
  | "UNSUPPORTED_LANGUAGE" | "INTERNAL";
```

One rule, enforced by review: **`context` is logged, never serialised to the client.** v1 leaks
raw exception messages (`e.message`) into responses in several routes, which is how clone paths
and internal state escape.

Wire format for every error:
```json
{ "error": { "code": "REPO_NOT_INDEXED", "message": "…", "requestId": "01J…" } }
```

### 9.2 Route inventory (v2)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/runs` | enqueue analysis → `202 {runId}` |
| `GET` | `/api/runs/:id` | run status + score + coverage |
| `GET` | `/api/runs/:id/events` | SSE progress |
| `GET` | `/api/runs/:id/findings` | **paginated + filterable** (was a JSON blob) |
| `GET` | `/api/runs/:id/sarif` | SARIF 2.1.0 download |
| `GET` | `/api/runs/:id/diff/:baseRunId` | new/fixed findings between runs |
| `POST` | `/api/findings/:id/fix` | enqueue FixJob for **one** finding |
| `POST` | `/api/findings/:id/suppress` | fingerprint-based |
| `POST` | `/api/fixes/:candidateId/publish` | requires `confirmed: true` |
| `GET` | `/api/metrics` | Prometheus |

---

## 10. `@codegraph/fsx`, `vcs`, `jobs`, `config`, `observability`

### 10.1 `fsx` — capability-scoped filesystem

```ts
/** The ONLY way to touch a workspace. No raw path strings escape this module. */
export interface WorkspaceHandle {
  readonly root: string;
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  list(rel: string): Promise<DirEntry[]>;
  /** Resolves, realpaths, and re-checks containment on EVERY access.
   *  v1 checks containment once at resolve time — a symlink created between
   *  resolve and use escapes. */
  resolve(rel: string): Promise<string>;
}
```

### 10.2 `vcs` — git + GitHub

```ts
export interface GitClient {
  clone(url: string, dest: string, opts: CloneOpts): Promise<void>;
  headSha(dir: string): Promise<string>;
  defaultBranch(dir: string): Promise<string>;
  churnByFile(dir: string, sinceDays: number): Promise<Map<string, number>>;
  applyEdits(dir: string, edits: readonly TextEdit[]): Promise<void>;
}

export interface GitHubClient {
  /** Token is injected at construction FROM SESSION ONLY. */
  repoInfo(owner: string, repo: string): Promise<{ defaultBranch: string }>;
  createPullRequest(input: PrInput): Promise<{ url: string; number: number }>;
}
```

Every error path through `vcs` passes through `redactCredentials` (already correct in v1 —
carry it forward verbatim).

### 10.3 `config` — typed and validated at boot

```ts
export const config = defineConfig({
  dataDir:            env.string("CG_DATA_DIR").default("./data"),
  workerConcurrency:  env.int("CG_WORKER_CONCURRENCY").default(1).min(1).max(8),
  maxFiles:           env.int("CG_MAX_FILES").default(4000),
  analysisBudgetMs:   env.int("CG_ANALYSIS_BUDGET_MS").default(120_000),
  allowLocalAccess:   env.bool("CG_ALLOW_LOCAL_ACCESS").default(false),
  allowTestVerification: env.bool("CG_ALLOW_TEST_VERIFICATION").default(false),
  trustedProxyHops:   env.int("CG_TRUSTED_PROXY_HOPS").default(1),
  // …
});
```

Fails fast at boot with every invalid var listed at once. No `process.env` reads anywhere else
— lint-enforced. v1 reads `process.env` in nine modules with inline defaults, so the effective
configuration is not knowable without grepping.

---

## 11. Testing strategy

### 11.1 The pyramid

| Layer | Count | Runtime | What it proves |
|---|---|---|---|
| **Unit** (pure functions) | ~70 % | < 5 s total | Scoring math, fingerprints, path safety, diff builder, dampening |
| **Rule tests** (per rule) | 1 fixture pair per rule | < 30 s | Each rule fires on the positive fixture and stays silent on the negative one |
| **Integration** (pipeline on a fixture repo) | ~20 % | < 60 s | Stages compose; cache hit/miss produce identical output |
| **Contract** (API schema) | per route | < 10 s | Request/response shapes; error codes; authz on every route |
| **E2E** (Playwright) | ~10 flows | < 5 min | Index → view → fix → publish |
| **Adversarial** (existing Docker smoke) | 1 | < 5 min | Survives 512 MB / 0.5 vCPU end-to-end |
| **Benchmark** (detection quality) | nightly + PR | < 10 min | Precision/recall per rule vs ground truth — **gates merges** |

### 11.2 Rule test convention

```
packages/detect-rules/rules/js/sql-injection.yaml
packages/detect-rules/tests/js/sql-injection/
  ├── positive.js        # must produce exactly N findings at marked lines
  ├── negative.js        # must produce ZERO — sanitised, parameterised, safe variants
  └── expected.sarif
```

The `negative.js` file is the one that matters and the one most projects skip. It is where
false positives get caught, and false positives are what kill adoption.

### 11.3 Property-based tests

Reach for `fast-check` on exactly the places v1 broke:

```ts
test.prop([arbitrarySourceFile(), arbitraryEditSet()])(
  "applying edits then re-parsing always yields a valid parse tree",
  (src, edits) => expect(parse(applyEdits(src, edits)).errors).toHaveLength(0),
);
```

That single property would have caught review bug B1 (brace-less `if` corruption) automatically.

### 11.4 Benchmark harness

```
benchmarks/
  fixtures/            hand-written, one dir per rule, with expected.sarif
  corpora/             pinned real repos (git submodule at a fixed SHA)
  adjudicated/         human-labelled ground truth for the corpora
  run.ts               → precision/recall/F1 per rule + overall, JSON scorecard
```

CI compares against the committed scorecard and fails on regression beyond a tolerance. The
scorecard is committed, so quality changes appear in the diff of a PR — the same way a
snapshot test works, applied to detection accuracy.

---

## 12. Coding standards

| Rule | Enforcement |
|---|---|
| No `any` (use `unknown` + narrowing) | `@typescript-eslint/no-explicit-any: error` |
| No default exports (except Next.js pages) | `import/no-default-export` |
| No deep cross-package imports | `no-restricted-imports` patterns |
| No `node:fs` / `child_process` / `node:sqlite` outside `fsx`/`vcs`/`persistence` | `no-restricted-imports` |
| No `process.env` outside `config` | `no-restricted-properties` |
| No `console.*` outside `observability` | `no-console: error` |
| No module-level mutable state | custom rule + review |
| No layering violations / cycles | `dependency-cruiser` in CI |
| Public functions documented with *why*, not *what* | review |
| Every file < 400 lines | `max-lines` warn at 300, error at 400 |

The last one is worth calling out: `indexer.ts` is 803 lines and does clone, walk, import
extraction, rule matching, scoring, viz-graph building, and tree building. Nothing about it is
individually wrong; the aggregate is why it cannot be tested in pieces.

---

## 13. Migration map — v1 file → v2 destination

| v1 file | Lines | Destination | Change |
|---|---|---|---|
| `lib/indexer.ts` | 803 | split 5 ways | `vcs` (clone) · `pipeline/enumerate` (walk) · `lang-*` (imports) · `detect-engine` (RULES) · `score-engine` (score) · `viz` (buildVizGraph) |
| `lib/store.ts` | 259 | `persistence` + `jobs` + `apps/worker` | `runJob` becomes a worker handler; SQL moves to repositories |
| `lib/db.ts` | 137 | `persistence/db.ts` + `migrations/` | ad-hoc ALTERs → numbered migrations |
| `lib/codeintel/graph.ts` | 265 | `core-graph` | + CFG construction |
| `lib/codeintel/query.ts` | 244 | `core-graph` | + `reachableCallers` (mirror of the existing `reachableCallees`), Tarjan SCC, uncapped `cycles()` (v1 caps at `maxReport=20`) |
| `lib/codeintel/extractors.ts` | 299 | `lang-typescript`, `lang-python` | interface preserved — it's already right |
| `lib/codeintel/ast-extractor.ts` | 174 | `lang-typescript` | RSS gate **deleted** — process isolation makes it unnecessary |
| `lib/agents/specialists.ts` | 357 | `detect-rules` (mostly) + `swarm` | most specialists are rules, not agents; only critic/judge remain orchestration |
| `lib/agents/orchestrator.ts` | 157 | `swarm` | `judgeScore`/`priorityOf` stay; `projectScore` → `score-engine` (real simulation) |
| `lib/agents/fixers.ts` | 181 | `remediate-engine/providers/` | line-based → AST/range-based; each gains `handles: [ruleId]` |
| `lib/agents/executor.ts` | 302 | `remediate-engine` + `apps/worker/handlers/fix.ts` | + 4-gate verification; − repo-wide walk; − inline PR push |
| `lib/workspace.ts` | 211 | `fsx` | + per-access realpath check |
| `lib/gitops.ts` + `gitops/*` | ~1700 | `vcs` + `packages/timeline` | timeline gets its own package and a `experimental` label |
| `lib/authz.ts` | — | `persistence` (viewer predicate) | route-level check → repository-level obligation |
| `lib/rateLimit.ts` | — | `apps/web/server/route.ts` | logic unchanged (it's correct); wiring becomes automatic |
| `lib/urlSafety.ts` | — | `vcs/urlSafety.ts` | + normalised IP forms (review B5) |
| `lib/session.ts`, `githubOAuth.ts`, `basicAuth.ts` | — | `apps/web/server/auth/` | unchanged logic |
| `app/api/**/route.ts` | 14 files | `apps/web/src/app/api/**` | all rewritten via `route()` helper |
| `components/**` | — | `apps/web/src/components/**` | unchanged in P1; refactor later |
| `terminal/` | — | `apps/cli` | promoted to a real workspace |
| `desktop/` | — | `apps/desktop` | **added to CI** |

### 13.1 Strangler-fig sequencing

Do not stop shipping. Each step keeps `main` green:

1. **Create packages, re-export from them.** `lib/indexer.ts` becomes a thin re-export of
   `@codegraph/score-engine` etc. Nothing else changes. Tests still pass.
2. **Move callers** off `lib/*` onto `@codegraph/*` one route at a time.
3. **Delete the shims** once no importers remain (`knip` finds them).
4. **New detection engine runs beside the old one** behind `CG_ENGINE=v1|v2|both`. In `both`,
   findings from each are tagged and the benchmark harness compares them. Cut over per-rule,
   when that rule's F1 beats v1's on the corpus.
5. **Old engine deleted** only when every rule has crossed over.

---

## 14. Definition of Done (per phase)

A phase is done when *all* of:

- [ ] `npm run typecheck` clean at `strict` + `noUncheckedIndexedAccess`
- [ ] `npm run lint` clean, including `dependency-cruiser`
- [ ] Unit + integration + contract tests green; coverage not decreased
- [ ] Benchmark scorecard committed and not regressed
- [ ] Docker adversarial smoke test green at 512 MB / 0.5 vCPU
- [ ] Migration runs forward cleanly on a copy of a real production DB
- [ ] Every new public function has a *why* comment; every new env var is in `config` + `DEPLOY.md`
- [ ] README claims touched by the phase re-verified against the code
