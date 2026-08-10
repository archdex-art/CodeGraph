import { isBaseline, type Baseline } from "@codegraph/analysis-model";

/** Repository-root file naming the findings this project has accepted. */
export const BASELINE_FILE = ".codegraph-baseline.json";

/**
 * Parse a repository's accepted-findings baseline.
 *
 * Pure, and deliberately so — the bytes are read by `indexer.ts`, which is the one file in
 * this package the fs gate exempts. Splitting it that way is not ceremony: `analysis` is an
 * analysis layer whose allow-list has no `observability` and no `node:fs` entry, and the
 * first version of this file quietly took both.
 *
 * Never throws and never partially applies: a malformed baseline means "no baseline", because
 * accepting an arbitrary subset that happened to parse would hide findings for reasons nobody
 * can see. The caller decides whether that is worth a log line; missing is the normal case and
 * says nothing at all.
 */
export function parseBaseline(text: string): Baseline | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isBaseline(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
