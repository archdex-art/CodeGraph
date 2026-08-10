import type { Issue } from "./models";

/**
 * Finding triage: identity, confidence tiers, and acceptance.
 *
 * WHY THIS EXISTS. Measured on this repository, 100 of 200 findings came from ONE rule
 * (`security/detect-non-literal-fs-filename`) and every sampled one was `mkdirSync(dir)` with
 * `dir` from config. A list where half the entries are the same weak signal is read once and
 * never again, and it takes the trustworthy findings down with it. The engine already
 * discounts those findings' CONFIDENCE; nothing downstream did anything with that number
 * except multiply it into the score. These helpers turn it into the axis the UI, the CI gate
 * and the baseline all sort on.
 *
 * Pure, and dependency-free like the rest of this package: the tiers are rendered in a client
 * component and enforced in a Node CLI, so neither may own them.
 */

export type ConfidenceTier = "high" | "medium" | "low";

/**
 * Tier boundaries.
 *
 * Chosen against the rule table rather than by taste. At 0.7 the `high` band admits
 * `eval()` (0.95), `Raw HTML injection sink` (0.95), `Empty catch block` (0.9),
 * `Hardcoded local URL` (0.9) and a TAINTED filesystem path (0.7 × 1.35 ≈ 0.95), and excludes
 * the untraced one (0.7 × 0.35 ≈ 0.25) that produced the noise. At 0.35 the `medium` band
 * keeps a lexical-tier hit of an otherwise-strong rule (0.95 × 0.45 ≈ 0.43) visible by
 * default, because "we could not parse Python" is a reason to weigh a finding less, not a
 * reason to hide it.
 *
 * An issue with NO confidence is `high`: absent means unqualified, and the two rules that
 * omit it are structural facts, not guesses.
 */
export const HIGH_CONFIDENCE = 0.7;
export const MEDIUM_CONFIDENCE = 0.35;

export function confidenceTier(issue: Pick<Issue, "confidence">): ConfidenceTier {
  const c = issue.confidence ?? 1;
  if (c >= HIGH_CONFIDENCE) return "high";
  if (c >= MEDIUM_CONFIDENCE) return "medium";
  return "low";
}

/**
 * Stable rule identity, with a fallback for rows persisted before `Issue.rule` existed.
 *
 * The fallback strips digits and bracketed spans, because the titles that lack an id are
 * exactly the dynamic ones (`Large file (656 LOC)`) — without that, one file crossing a
 * threshold invents a new "rule" and a baseline written yesterday stops matching today.
 */
export function ruleIdOf(issue: Pick<Issue, "rule" | "title">): string {
  if (issue.rule) return issue.rule;
  return issue.title
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\d+/g, "")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The key a baseline entry matches on: RULE and FILE, deliberately not line or column.
 *
 * A line-keyed baseline expires on the next commit that adds an import, so every accepted
 * finding comes back as "new" and the gate cries wolf until someone turns it off. Coarser is
 * the correct trade here and it is the same one `.dependency-cruiser-known-violations.json`
 * already makes in this repository: you accept "this rule, in this file", and a genuinely new
 * instance in a DIFFERENT file still fails the build.
 */
export function findingKey(issue: Pick<Issue, "rule" | "title" | "file">): string {
  return `${ruleIdOf(issue)}::${issue.file}`;
}

/** On-disk shape of `.codegraph-baseline.json`. */
export interface Baseline {
  version: 1;
  /** ISO date the file was written, for the "accepted 8 months ago" nudge. */
  generatedAt: string;
  /** `findingKey` values, sorted, one per accepted (rule, file) pair. */
  accepted: string[];
}

export function isBaseline(value: unknown): value is Baseline {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<Baseline>;
  return b.version === 1 && Array.isArray(b.accepted) && b.accepted.every((k) => typeof k === "string");
}

export function buildBaseline(issues: readonly Issue[], now = new Date()): Baseline {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    accepted: [...new Set(issues.map(findingKey))].sort(),
  };
}

/**
 * Mark accepted findings rather than dropping them.
 *
 * Returns a NEW array; the caller's issues are inputs to a cache and must not be mutated.
 */
export function applyBaseline(issues: readonly Issue[], baseline: Baseline | null): Issue[] {
  if (!baseline || !baseline.accepted.length) return [...issues];
  const accepted = new Set(baseline.accepted);
  return issues.map((i) => (accepted.has(findingKey(i)) ? { ...i, suppressed: true } : i));
}

/** Findings that count — for the score, for the CI gate, for the headline number. */
export function activeIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter((i) => !i.suppressed);
}

/**
 * What the CI gate fails on: unaccepted findings at or above `tier`.
 *
 * `low` is deliberately gateable too — a team that wants everything can ask for it — but the
 * default is `high`, because a gate that fires on a weak signal is a gate that gets deleted.
 */
export function gateFindings(issues: readonly Issue[], tier: ConfidenceTier = "high"): Issue[] {
  const rank: Record<ConfidenceTier, number> = { high: 3, medium: 2, low: 1 };
  return activeIssues(issues).filter((i) => rank[confidenceTier(i)] >= rank[tier]);
}

/**
 * Per-rule contribution tally — "what is costing you points", the question the Health Score
 * could not answer. Sorted by count, because the first thing a reader needs to know is
 * whether one rule is drowning the list.
 */
export interface RuleTally {
  rule: string;
  title: string;
  count: number;
  suppressed: number;
  tier: ConfidenceTier;
}

export function tallyByRule(issues: readonly Issue[]): RuleTally[] {
  const byRule = new Map<string, RuleTally>();
  for (const issue of issues) {
    const rule = ruleIdOf(issue);
    const existing = byRule.get(rule);
    if (existing) {
      existing.count++;
      if (issue.suppressed) existing.suppressed++;
      continue;
    }
    byRule.set(rule, {
      rule,
      title: issue.title,
      count: 1,
      suppressed: issue.suppressed ? 1 : 0,
      tier: confidenceTier(issue),
    });
  }
  return [...byRule.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}
