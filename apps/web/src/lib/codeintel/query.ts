/** Re-export shim (LLD §13.1 step 1, §13.2). Moved to `@codegraph/core-graph`. */
export { QueryEngine } from "@codegraph/core-graph";

import type { CodeSymbol, QueryEngine } from "@codegraph/core-graph";

/**
 * Is this path a test file?
 *
 * A deliberate copy of `isTestFile` from `@codegraph/detect-engine`. `apps/web` does
 * not depend on that package, and taking the dependency to read one predicate would
 * pull the whole detection engine — tree-sitter grammars, the ESLint security host —
 * into the app's module graph for a regex. `packages/detect-engine/src/detect.ts`
 * owns the original and the comment explaining why each convention is on the list
 * (short version: the one-clever-regex version reported "no tests" on repositories
 * whose entire suite is a top-level `test.js`). Change one, change both.
 */
export function isTestFile(rel: string): boolean {
  const path = rel.replace(/\\/g, "/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  const stem = base.replace(/\.[^.]+$/, "");
  return (
    /(^|\/)(tests?|specs?|__tests__|testing)\//i.test(path) ||
    /[._-](test|spec)$/i.test(stem) ||
    /^(test|spec)[._-]/i.test(stem) ||
    /^(tests?|specs?)$/i.test(stem) ||
    /^(test|tests)[A-Z]/.test(stem) ||
    /(Test|Tests|Spec)$/.test(stem) ||
    /^conftest$/i.test(stem)
  );
}

/** One transitive caller of the symbol under inspection. */
export interface BlastCaller {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  /** Shortest number of call hops from the inspected symbol out to this caller. */
  hops: number;
  /** This caller lives in a test file, so the suite already walks through here. */
  tested: boolean;
}

/** "What breaks if I change this" — the answer, with the parts that make it actionable. */
export interface BlastReport {
  symbol: CodeSymbol | null;
  callers: BlastCaller[];
  /** Callers found at each hop; index 0 is one hop out. */
  perHop: number[];
  /** How many of `callers` sit in a test file. */
  testedCount: number;
  /** The hop cap the traversal ran under. */
  depth: number;
}

/**
 * The transitive caller set of `id`, each caller marked covered or not.
 *
 * The distances come from `QueryEngine.impactWithHops`, which is the same traversal
 * `impact()` uses — the panel adds the test marking, it does not add a second walk of
 * the graph.
 *
 * "Covered" here means a caller that IS a test file, i.e. a chain from the suite
 * reaches this symbol. It is call-graph coverage, not line coverage: it says the code
 * is reachable from a test, not that the test asserts anything about it. That is still
 * the useful distinction, because a symbol no test chain reaches cannot be covered at
 * all.
 */
export function blastRadius(qe: QueryEngine, id: string, depth = 4): BlastReport {
  const reached = qe.impactWithHops(id, depth);
  const callers: BlastCaller[] = reached.map(({ symbol, hops }) => ({
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    line: symbol.line,
    hops,
    tested: isTestFile(symbol.file),
  }));
  const perHop = Array.from({ length: depth }, (_, i) => callers.filter((c) => c.hops === i + 1).length);
  return {
    symbol: qe.get(id) ?? null,
    callers,
    perHop,
    testedCount: callers.filter((c) => c.tested).length,
    depth,
  };
}

/**
 * Hub symbols that no test file calls: the code most depended upon with nothing
 * exercising it.
 *
 * SHARED ON PURPOSE with the agent swarm — `specialists.ts` Pass 2 ("Untested core
 * logic") raises a finding for exactly this set, and the impact page reports it. Two
 * copies of the predicate would eventually disagree, and the page would then be
 * quietly contradicting the remediation plan sitting one tab away. The swarm consumes
 * this list in order and stops when its finding budget runs out, so the order below is
 * load-bearing: it is `hubs()` connectivity order, unchanged.
 *
 * `fanIn >= 2` because a single caller is not a hub, and test files are skipped as
 * subjects because "the test is untested" is not a finding.
 */
export function untestedHubs(qe: QueryEngine, scan = 30): CodeSymbol[] {
  return qe
    .hubs(scan)
    .filter((h) => !isTestFile(h.file) && h.fanIn >= 2 && !qe.callers(h.id).some((c) => isTestFile(c.file)));
}

/**
 * The same set, ordered for reading: most-depended-upon first.
 *
 * A separate function rather than a sort inside `untestedHubs` because the swarm reads
 * that list in `hubs()` order and truncates it; re-ranking there would silently change
 * which findings survive the budget. A copy, so the caller's array is untouched.
 */
export function rankUntestedHubs(hubs: readonly CodeSymbol[]): CodeSymbol[] {
  return [...hubs].sort((a, b) => b.fanIn - a.fanIn || a.name.localeCompare(b.name));
}
