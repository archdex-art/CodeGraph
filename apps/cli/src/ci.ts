import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { indexRepo, parseBaseline } from "@codegraph/analysis";
import {
  activeIssues,
  applyBaseline,
  buildBaseline,
  confidenceTier,
  findingKey,
  gateFindings,
  ruleIdOf,
  tallyByRule,
  toSarif,
  type Baseline,
  type ConfidenceTier,
  type Issue,
  type RuleTally,
} from "@codegraph/analysis-model";

/**
 * `codegraph ci` / `codegraph baseline` — the gate a pull request runs (review C3).
 *
 * The product had a Health Score, a SARIF exporter and a baseline format, and no way to put
 * any of them in front of a change before it merged. Everything here is assembly of parts
 * that already exist; the only decisions it makes are the two a CI story has to make.
 *
 * DECISION 1 — the exit code is the verdict, and it is derived from `gateFindings`, not from
 * the score. A score threshold fails a PR for debt the author did not write; a tier gate fails
 * it for findings the author can see, check against `evidence`, and either fix or accept.
 *
 * DECISION 2 — accepted findings are REPORTED, never dropped. They stay in the SARIF (marked
 * suppressed), they are counted in the summary, and they are out of the score. A baseline that
 * makes findings vanish is an allowlist nobody reviews.
 */

/** Mirrors `@codegraph/analysis`'s `BASELINE_FILE`, which its package index does not export. */
export const BASELINE_FILE = ".codegraph-baseline.json";

/** How many gating findings the JSON summary carries. */
const GATING_LIMIT = 50;

export interface CiOptions {
  readonly repo: string;
  readonly failOn: ConfidenceTier;
  /** Baseline file, absolute or relative to the repository root. */
  readonly baseline: string;
  readonly sarif?: string;
  readonly json?: string;
}

export interface CiFinding {
  rule: string;
  file: string;
  line: number;
  title: string;
  tier: ConfidenceTier;
  severity: number;
  confidence?: number;
  evidence?: string;
}

export interface CiSummary {
  /** Health Score of the analysed tree — reported, deliberately not gated on. */
  score: number;
  repo: string;
  failOn: ConfidenceTier;
  passed: boolean;
  /** Every finding reported, accepted ones included. */
  total: number;
  /** Findings that count: reported minus accepted. */
  active: number;
  /** Accepted by a baseline entry or an inline `codegraph-ignore`. */
  accepted: number;
  /** The subset of `accepted` that the baseline file is responsible for. */
  acceptedByBaseline: number;
  /** The baseline actually read, or null when the repository has none. */
  baselineFile: string | null;
  /** Active findings per confidence tier; accepted ones are in `accepted`, not here. */
  tiers: Record<ConfidenceTier, number>;
  rules: RuleTally[];
  gatingCount: number;
  /** The worst `GATING_LIMIT` gating findings — a PR comment shows five of these. */
  gating: CiFinding[];
  sarif: string | null;
}

/**
 * Read a baseline from an explicit PATH.
 *
 * The pipeline reads the repository root and hardcodes the filename, which cannot answer
 * `--baseline ci/accepted.json`; this supplies the path. What counts as a VALID baseline is
 * not re-decided here — `parseBaseline` is the one parser, so the gate and the pipeline can
 * never disagree about which findings a project has accepted.
 */
function readBaselineAt(file: string): Baseline | null {
  if (!existsSync(file)) return null;
  try {
    return parseBaseline(readFileSync(file, "utf8"));
  } catch {
    // Unreadable (permissions, a directory, a race with a writer) — same answer as malformed.
    return null;
  }
}

/**
 * Index once and answer every question the gate asks from that one result.
 *
 * `indexRepo` runs against the working tree in place — no copy, unlike `runFix`, because
 * nothing here writes to the repository and CI has already checked out exactly the commit
 * under test. Uncommitted changes are analysed, which is what a developer running this by
 * hand before pushing wants.
 */
export async function runCi(opts: CiOptions): Promise<CiSummary> {
  const repo = path.resolve(opts.repo);
  // `--baseline` names a repository-level file, so a relative path resolves against the repo.
  const file = path.isAbsolute(opts.baseline) ? opts.baseline : path.join(repo, opts.baseline);
  const baseline = readBaselineAt(file);

  const result = await indexRepo(repo);

  // `indexRepo` already applied `<root>/.codegraph-baseline.json`, which is the default and the
  // overwhelmingly common case. Re-applying it here is a no-op (the same keys, the same flag);
  // applying a NON-default `--baseline` here is the only way it can be honoured at all, since
  // the pipeline takes no parameter for it.
  const issues = applyBaseline(result.issues, baseline);

  const accepted = issues.filter((i) => i.suppressed);
  const acceptedKeys = new Set(baseline?.accepted ?? []);
  const gating = gateFindings(issues, opts.failOn);

  const tiers: Record<ConfidenceTier, number> = { high: 0, medium: 0, low: 0 };
  for (const issue of activeIssues(issues)) tiers[confidenceTier(issue)]++;

  const summary: CiSummary = {
    score: result.score,
    repo,
    failOn: opts.failOn,
    passed: gating.length === 0,
    total: issues.length,
    active: issues.length - accepted.length,
    accepted: accepted.length,
    acceptedByBaseline: accepted.filter((i) => acceptedKeys.has(findingKey(i))).length,
    baselineFile: baseline ? path.relative(repo, file) || path.basename(file) : null,
    tiers,
    // Tallied over ALL findings, accepted included: "this rule fires 40 times and you accepted
    // 38 of them" is the sentence that tells a team the rule is miscalibrated, and dropping the
    // accepted ones first hides it.
    rules: tallyByRule(issues),
    gatingCount: gating.length,
    gating: [...gating].sort(worstFirst).slice(0, GATING_LIMIT).map(toFinding),
    sarif: opts.sarif ?? null,
  };

  if (opts.sarif) {
    // Every finding, accepted ones included and marked `suppressions: external` — code scanning
    // then shows them as dismissed rather than as never having existed.
    writeFileSync(
      path.resolve(opts.sarif),
      `${JSON.stringify(toSarif(issues, { endTimeUtc: new Date().toISOString() }), null, 2)}\n`
    );
  }
  if (opts.json) {
    writeFileSync(path.resolve(opts.json), `${JSON.stringify(summary, null, 2)}\n`);
  }

  return summary;
}

/** Severity first, then confidence: the five a reviewer reads first must be the worst five. */
function worstFirst(a: Issue, b: Issue): number {
  return (
    b.severity - a.severity ||
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

function toFinding(issue: Issue): CiFinding {
  return {
    rule: ruleIdOf(issue),
    file: issue.file,
    line: issue.line,
    title: issue.title,
    tier: confidenceTier(issue),
    severity: issue.severity,
    ...(issue.confidence === undefined ? {} : { confidence: issue.confidence }),
    ...(issue.evidence === undefined ? {} : { evidence: issue.evidence }),
  };
}

export interface BaselineOutcome {
  /** Absolute path written. */
  file: string;
  /**
   * Entries in the written baseline — NOT the number of findings accepted.
   *
   * `findingKey` is rule+file, so one entry can accept a dozen findings. Reporting the entry
   * count as "findings accepted" understates the blast radius of the file being written, which
   * is the one number the person adopting the gate is deciding on.
   */
  entries: number;
  /** Findings the written baseline accepts — what `ci` will then report as accepted. */
  covered: number;
  /** Entries this run added on top of what the file already held. */
  added: number;
  score: number;
}

/**
 * `codegraph baseline` — adopt the gate on an existing codebase without a thousand-line PR.
 *
 * MERGED with the file already on disk rather than overwriting it. `indexRepo` applies the
 * existing baseline before this sees the findings, so everything previously accepted comes back
 * SUPPRESSED and is therefore absent from `activeIssues` — writing that set alone would drop
 * every prior entry and re-open every finding the team had already signed off. Running the
 * command twice must not undo the first run.
 *
 * A stale entry (the finding was fixed) matches nothing and costs nothing; a dropped entry
 * breaks the build. The asymmetry decides it.
 */
export async function runBaseline(opts: {
  readonly repo: string;
  readonly baseline: string;
}): Promise<BaselineOutcome> {
  const repo = path.resolve(opts.repo);
  const file = path.isAbsolute(opts.baseline) ? opts.baseline : path.join(repo, opts.baseline);
  const prior = readBaselineAt(file);

  const result = await indexRepo(repo);
  const fresh = buildBaseline(activeIssues(applyBaseline(result.issues, prior)));
  const merged = [...new Set([...(prior?.accepted ?? []), ...fresh.accepted])].sort();

  const written: Baseline = { ...fresh, accepted: merged };
  writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`);

  // Counted over the raw findings rather than by re-applying: `applyBaseline` also preserves
  // findings already suppressed by an inline `codegraph-ignore`, and those are not this file's
  // doing. Same predicate as `runCi`'s `acceptedByBaseline`, so the two numbers agree.
  const keys = new Set(merged);

  return {
    file,
    entries: merged.length,
    covered: result.issues.filter((i) => keys.has(findingKey(i))).length,
    added: merged.length - (prior?.accepted.length ?? 0),
    score: result.score,
  };
}
