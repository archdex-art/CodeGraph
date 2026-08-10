import { isTestFile } from "@codegraph/detect-engine";
import { endpointsAffectedBy } from "@codegraph/core-graph";
import { recommendReviewers, type Commit, type ReviewerRecommendation } from "@codegraph/vcs";
import { QueryEngine } from "@/lib/codeintel/query";
import type { ApiEndpoint, ApiSurface, CodeSymbol, SymbolGraph } from "@/lib/types";
import type { ChangedFile } from "./diff";

/**
 * PR intelligence: what a diff actually touches, and what that reaches.
 *
 * Everything here derives from analyses that already exist — the symbol graph, the API surface,
 * the ownership history — so this module joins rather than computes. That is deliberate: a
 * second definition of "which symbol does this line belong to" or "who should review this"
 * would drift from the first, and the two would then disagree in the UI.
 *
 * WHAT THIS CANNOT SEE, stated plainly because a risk score invites more trust than it earns:
 *
 *   · Symbol spans come from the CURRENT index, not from the head commit of the diff. A PR that
 *     moves a function is matched against where the function is now. Re-indexing at `head`
 *     would fix it and costs a full index per request, which is not a trade this route makes.
 *   · A deleted file has no post-image, so its symbols are attributed BY PATH and its changed
 *     ranges are unknowable. Reported, never guessed.
 *   · Blast radius is only as complete as the graph's resolved call edges — dynamic dispatch,
 *     reflection and unresolved cross-module calls are invisible, so it is a LOWER BOUND.
 *   · Risk is a weighted sum of measured quantities, not a probability. It ranks; it does not
 *     predict. Every term is published in `factors` with its evidence so the number can be
 *     argued with rather than believed.
 */

/** Symbols carried out of one PR. Past this the change is a sweep and the list is noise. */
const MAX_CHANGED_SYMBOLS = 500;

/** Hops walked for blast radius. Matches the intel route's `impact` default. */
const IMPACT_DEPTH = 3;

/** Blast-radius entries returned. A hub with 4,000 callers answers nothing by listing them. */
const MAX_IMPACT = 300;

/** Endpoints and DB models reported. */
const MAX_ENDPOINTS = 100;
const MAX_DB_MODELS = 100;

/** Test files reported. */
const MAX_TESTS = 200;

/** Reviewers asked for. More than a handful is a list nobody acts on. */
const MAX_REVIEWERS = 5;

export interface ChangedSymbol {
  readonly symbolId: string;
  readonly name: string;
  readonly file: string;
  readonly kind: string;
  /** How the symbol was attributed: by line intersection, or by its file being deleted. */
  readonly via: "line-range" | "file-removed";
}

export interface AffectedModel {
  readonly name: string;
  readonly file: string;
  readonly evidence: string;
}

export interface ImpactedSymbol {
  readonly symbolId: string;
  readonly name: string;
  readonly file: string;
  readonly hops: number;
}

export interface RelevantTest {
  readonly file: string;
  readonly reason: string;
}

export interface RiskFactor {
  readonly name: string;
  /** The measured quantity, before weighting. */
  readonly value: number;
  readonly weight: number;
  /** One line naming what was measured, so the term can be checked without reading the code. */
  readonly evidence: string;
}

export interface PrAnalysis {
  readonly base: string;
  readonly head: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly changedSymbols: readonly ChangedSymbol[];
  readonly affectedEndpoints: readonly ApiEndpoint[];
  readonly affectedModules: readonly string[];
  readonly affectedDbModels: readonly AffectedModel[];
  readonly dependencyImpact: readonly ImpactedSymbol[];
  readonly relevantTests: readonly RelevantTest[];
  readonly reviewers: readonly ReviewerRecommendation[];
  readonly risk: {
    readonly score: number;
    readonly band: "low" | "medium" | "high";
    readonly factors: readonly RiskFactor[];
  };
  /** A cap was hit somewhere: every list is a prefix of the truth. */
  readonly truncated: boolean;
}

export interface PrAnalysisInput {
  readonly base: string;
  readonly head: string;
  readonly changed: readonly ChangedFile[];
  readonly graph: SymbolGraph;
  readonly apiSurface?: ApiSurface | undefined;
  /** Commit history for reviewer recommendation. Empty disables reviewers, honestly. */
  readonly commits: readonly Commit[];
  /** Window the commits were drawn from, in days — `recommendReviewers` needs it. */
  readonly windowDays: number;
  /** Repo-relative paths of every file the index scanned, for test discovery. */
  readonly files: ReadonlyArray<{ readonly rel: string; readonly text?: string | undefined }>;
}

/**
 * Symbols whose span intersects a changed range.
 *
 * The same intersection `symbolOwnership` performs against commit hunks — the shapes differ
 * (a diff rather than a log) but the rule must not, or "this commit touched X" and "this PR
 * touched X" would disagree about the same lines.
 */
function changedSymbolsOf(changed: readonly ChangedFile[], graph: SymbolGraph): {
  symbols: ChangedSymbol[];
  truncated: boolean;
} {
  const byFile = new Map<string, CodeSymbol[]>();
  for (const s of graph.symbols) {
    // Synthetic module nodes span the whole file and would match every change in it, turning
    // any edit into "the module changed" — true and useless.
    if (s.kind === "module") continue;
    const list = byFile.get(s.file);
    if (list) list.push(s);
    else byFile.set(s.file, [s]);
  }

  const out: ChangedSymbol[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const file of changed) {
    const symbols = byFile.get(file.path);
    if (!symbols) continue;

    for (const s of symbols) {
      if (seen.has(s.id)) continue;
      // A deleted file has no post-image and therefore no ranges. Every symbol that WAS in it
      // is gone, which is a change to all of them — attributing by path is the honest answer,
      // and skipping the file because it has no ranges would silently under-report a deletion.
      const hit =
        file.status === "deleted" ||
        file.ranges.some(([start, end]) => start <= s.endLine && end >= s.line);
      if (!hit) continue;
      if (out.length >= MAX_CHANGED_SYMBOLS) {
        truncated = true;
        break;
      }
      seen.add(s.id);
      out.push({
        symbolId: s.id,
        name: s.name,
        file: s.file,
        kind: s.kind,
        via: file.status === "deleted" ? "file-removed" : "line-range",
      });
    }
  }

  out.sort((a, b) => a.file.localeCompare(b.file) || a.symbolId.localeCompare(b.symbolId));
  return { symbols: out, truncated };
}

/** Top-level directory of a repo-relative path — the same grouping the module graph uses. */
function moduleOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

export function analysePr(input: PrAnalysisInput): PrAnalysis {
  const qe = new QueryEngine(input.graph);
  const { symbols: changedSymbols, truncated: symbolsTruncated } = changedSymbolsOf(
    input.changed,
    input.graph,
  );
  let truncated = symbolsTruncated;

  const changedPaths = new Set(input.changed.map((f) => f.path));
  const changedIds = new Set(changedSymbols.map((s) => s.symbolId));

  // ── Affected endpoints ────────────────────────────────────────────────────────────────
  const endpointsById = new Map<string, ApiEndpoint>();
  if (input.apiSurface) {
    // An endpoint whose own file changed is affected whether or not a symbol matched — the
    // route file is the endpoint's definition.
    for (const e of input.apiSurface.endpoints) {
      if (changedPaths.has(e.file)) endpointsById.set(e.id, e);
    }
    for (const s of changedSymbols) {
      if (endpointsById.size >= MAX_ENDPOINTS) {
        truncated = true;
        break;
      }
      for (const e of endpointsAffectedBy(input.apiSurface, input.graph, s.symbolId)) {
        endpointsById.set(e.id, e);
      }
    }
  }
  const affectedEndpoints = [...endpointsById.values()].sort((a, b) => a.id.localeCompare(b.id));

  // ── Dependency impact ─────────────────────────────────────────────────────────────────
  const impacted = new Map<string, ImpactedSymbol>();
  for (const s of changedSymbols) {
    for (const caller of qe.impact(s.symbolId, IMPACT_DEPTH)) {
      // A changed symbol is not its own blast radius. Leaving them in inflates every count and
      // makes a one-function PR look like it reaches itself.
      if (changedIds.has(caller.id)) continue;
      if (impacted.has(caller.id)) continue;
      if (impacted.size >= MAX_IMPACT) {
        truncated = true;
        break;
      }
      impacted.set(caller.id, {
        symbolId: caller.id,
        name: caller.name,
        file: caller.file,
        // `impact` returns the reachable set without per-node depth, so the honest report is
        // the bound it was computed at rather than a per-symbol number we did not measure.
        hops: IMPACT_DEPTH,
      });
    }
  }
  const dependencyImpact = [...impacted.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.symbolId.localeCompare(b.symbolId),
  );

  // ── Affected database models ──────────────────────────────────────────────────────────
  const models = new Map<string, AffectedModel>();
  const consider = (s: CodeSymbol, why: string): void => {
    if (!s.tags.includes("db")) return;
    if (models.size >= MAX_DB_MODELS) {
      truncated = true;
      return;
    }
    if (!models.has(s.id)) models.set(s.id, { name: s.name, file: s.file, evidence: why });
  };
  for (const s of changedSymbols) {
    const sym = qe.get(s.symbolId);
    if (sym) consider(sym, "changed, and tagged `db`");
    for (const callee of qe.callees(s.symbolId)) {
      consider(callee, `called by changed \`${s.name}\``);
    }
  }
  const affectedDbModels = [...models.values()].sort((a, b) => a.name.localeCompare(b.name));

  // ── Relevant tests ────────────────────────────────────────────────────────────────────
  const tests = new Map<string, RelevantTest>();
  const changedSymbolNames = new Set(changedSymbols.map((s) => s.name));
  // Everything the change reaches, computed once. `impacted` is the transitive caller set from
  // above, so a test three layers up is still connected to the edit.
  const reachable = new Set<string>([...changedIds, ...impacted.keys()]);

  for (const file of input.files) {
    if (tests.size >= MAX_TESTS) {
      truncated = true;
      break;
    }
    // ONE definition of "test file", shared with the detector. A second regex here is how the
    // scorer and this route would come to disagree about what a test is.
    if (!isTestFile(file.rel)) continue;

    // Reason 1: the test file imports a changed file. Matched on the path stem so
    // `../src/pay` resolves to `src/pay.ts` without re-implementing module resolution.
    const text = file.text ?? "";
    const importsChanged = [...changedPaths].find((p) => {
      const stem = p.replace(/\.[cm]?[jt]sx?$/, "");
      const base = stem.slice(stem.lastIndexOf("/") + 1);
      return base.length > 2 && new RegExp(`["'\`][^"'\`]*${base}["'\`/]`).test(text);
    });
    if (importsChanged !== undefined) {
      tests.set(file.rel, { file: file.rel, reason: `imports ${importsChanged}` });
      continue;
    }

    /**
     * Reason 2: a symbol in the test file REACHES changed code through the call graph.
     *
     * Transitive, via the impact set — not a single hop. A test imports the service it is
     * testing and the change is usually a layer below that, so a one-hop check finds nothing
     * and this second reason would only ever fire where reason 1 already had. That is exactly
     * the "changed code -> affected tests" case a filename convention cannot answer.
     */
    const caller = input.graph.symbols.find(
      (s) =>
        s.file === file.rel &&
        qe.callees(s.id).some((c) => reachable.has(c.id) || changedSymbolNames.has(c.name)),
    );
    if (caller) {
      tests.set(file.rel, { file: file.rel, reason: `calls changed code from \`${caller.name}\`` });
    }
  }
  const relevantTests = [...tests.values()].sort((a, b) => a.file.localeCompare(b.file));

  // ── Reviewers ─────────────────────────────────────────────────────────────────────────
  // Delegated whole: the ranking, the inactivity exclusion and the reasons all live in
  // `@codegraph/vcs`, and a second ranking here would be a second answer to the same question.
  const reviewers =
    input.commits.length === 0
      ? []
      : recommendReviewers(input.commits, [...changedPaths], {
          windowDays: input.windowDays,
          maxReviewers: MAX_REVIEWERS,
        });

  // ── Risk ──────────────────────────────────────────────────────────────────────────────
  /**
   * A weighted sum of MEASURED quantities, published term by term.
   *
   * Each `value` is normalised to 0..1 by a saturation point chosen so the term stops growing
   * once it has made its point — a 400-symbol PR is not four times riskier than a 100-symbol
   * one, it is simply large. The weights are hand-picked and say so; what makes the number
   * defensible is not their calibration but that every input is visible and checkable.
   *
   * There is deliberately no constant term. A PR that changes nothing measurable scores zero.
   */
  const saturate = (n: number, at: number): number => Math.min(1, n / at);
  const untestedChange = relevantTests.length === 0 && changedSymbols.length > 0;
  const factors: RiskFactor[] = [
    {
      name: "changed-symbols",
      value: saturate(changedSymbols.length, 40),
      weight: 0.2,
      evidence: `${changedSymbols.length} symbol(s) intersect the diff`,
    },
    {
      name: "blast-radius",
      value: saturate(dependencyImpact.length, 120),
      weight: 0.3,
      evidence: `${dependencyImpact.length} symbol(s) transitively depend on the change (${IMPACT_DEPTH} hops)`,
    },
    {
      name: "api-surface",
      value: saturate(affectedEndpoints.length, 8),
      weight: 0.2,
      evidence: `${affectedEndpoints.length} HTTP endpoint(s) reach the change`,
    },
    {
      name: "database-models",
      value: saturate(affectedDbModels.length, 6),
      weight: 0.15,
      evidence: `${affectedDbModels.length} database-tagged symbol(s) touched or called`,
    },
    {
      name: "test-coverage",
      value: untestedChange ? 1 : 0,
      weight: 0.15,
      evidence: untestedChange
        ? "no test file imports or calls any changed symbol"
        : `${relevantTests.length} related test file(s) found`,
    },
  ];
  const score = Math.round(factors.reduce((sum, f) => sum + f.value * f.weight, 0) * 100);
  const band = score >= 60 ? "high" : score >= 30 ? "medium" : "low";

  const affectedModules = [...new Set(input.changed.map((f) => moduleOf(f.path)))].sort();

  return {
    base: input.base,
    head: input.head,
    changedFiles: input.changed,
    changedSymbols,
    affectedEndpoints,
    affectedModules,
    affectedDbModels,
    dependencyImpact,
    relevantTests,
    reviewers,
    risk: { score, band, factors },
    truncated: truncated || input.graph.truncated,
  };
}
