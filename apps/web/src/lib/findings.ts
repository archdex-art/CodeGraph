import { confidenceTier, findingKey, ruleIdOf, tallyByRule } from "@codegraph/analysis-model";
import type { ConfidenceTier, Issue, RuleTally } from "@codegraph/analysis-model";
/*
 * The registry SUBPATH, not the package root. `@codegraph/remediate-engine` re-exports the
 * apply loop, which imports `node:fs`; this module is read by client components, so pulling
 * the root in would drag the filesystem into the browser bundle. `providers/fixers` imports
 * nothing but types, which is why it is safe to expose as its own entry point.
 */
import { fixersForRule, legacyRuleIdFor } from "@codegraph/remediate-engine/fixers";

/**
 * Reading a findings list, as opposed to counting one.
 *
 * Measured on this repository: 200 findings, of which 100 come from a single
 * low-confidence rule and 19 more from another. A flat list of 200 rows does not carry
 * 200 pieces of information — it carries one ("something is wrong somewhere") plus 199
 * rows that each cost a read and mostly do not survive it. The reliable human response
 * to that list is to stop reading it, which is how a scanner ends up shipping noise and
 * being ignored rather than shipping nothing and being missed.
 *
 * So confidence becomes STRUCTURE rather than a number in a tooltip: the tiers a reader
 * should act on are open, the heuristic tier is one collapsed count, and findings the
 * repository has already accepted are their own group — still listed, because a
 * suppression that hides itself is how a baseline becomes a place findings go to die.
 *
 * Pure on purpose. The grouping is the part that has to be right, and a rendered
 * component is a bad place to prove that it is.
 */

/** Which group is expanded. `default` is the answer to "what should I read first". */
export const TIER_FILTERS = ["default", "high", "medium", "low", "accepted", "all"] as const;
export type TierFilter = (typeof TIER_FILTERS)[number];

export type FindingGroupKey = ConfidenceTier | "accepted";

const GROUP_ORDER: readonly FindingGroupKey[] = ["high", "medium", "low", "accepted"];

export const GROUP_META: Record<FindingGroupKey, { label: string; short: string; note: string }> = {
  high: {
    label: "High confidence",
    short: "high",
    note: "The detector matched something specific. Read the evidence, then act.",
  },
  medium: {
    label: "Medium confidence",
    short: "medium",
    note: "A pattern fired without proof. Check the evidence line before you spend a commit on it.",
  },
  low: {
    label: "Low confidence",
    short: "low-confidence",
    note: "Heuristics. Expect false positives here — this group is collapsed so it cannot drown the rest.",
  },
  accepted: {
    label: "Accepted",
    short: "accepted",
    note: "Suppressed by an inline codegraph-ignore or by .codegraph-baseline.json. Still reported, not charged to the score.",
  },
};

/** Unknown or absent `?tier=` reads as the default view rather than as an error. */
export function parseTierFilter(raw: string | null | undefined): TierFilter {
  const value = (raw ?? "").toLowerCase();
  return (TIER_FILTERS as readonly string[]).includes(value) ? (value as TierFilter) : "default";
}

function isOpen(key: FindingGroupKey, filter: TierFilter): boolean {
  if (filter === "all") return true;
  if (filter === "default") return key === "high" || key === "medium";
  return key === filter;
}

export interface FindingGroup {
  key: FindingGroupKey;
  label: string;
  short: string;
  note: string;
  /** Input order preserved: the scorer already ranked by severity × blast radius. */
  issues: Issue[];
  open: boolean;
}

export interface TieredFindings {
  /** Every non-empty group, in descending confidence. Closed groups still carry a count. */
  groups: FindingGroup[];
  total: number;
  /** In the open groups — the number of rows the reader is actually being asked to read. */
  shown: number;
  hidden: number;
}

export function groupByTier(issues: readonly Issue[], filter: TierFilter = "default"): TieredFindings {
  const buckets: Record<FindingGroupKey, Issue[]> = { high: [], medium: [], low: [], accepted: [] };
  // Accepted wins over the tier: an accepted high-confidence finding listed under "High"
  // would read as outstanding work, which is exactly what accepting it said it is not.
  for (const issue of issues) buckets[issue.suppressed ? "accepted" : confidenceTier(issue)].push(issue);

  const groups = GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    ...GROUP_META[key],
    issues: buckets[key],
    open: isOpen(key, filter),
  }));
  const shown = groups.reduce((n, g) => (g.open ? n + g.issues.length : n), 0);
  return { groups, total: issues.length, shown, hidden: issues.length - shown };
}

/**
 * The per-rule breakdown the Health Score cannot give you: which rule is producing the
 * list, and how much of it is one rule.
 *
 * Thin over `tallyByRule` — the tally is the model's, and re-deriving it here would put
 * two answers to "how many" on one page. What this adds is the two things the tally
 * cannot know on its own: how big a row is relative to the whole list, and whether the
 * row's id is real.
 *
 * `derived` is the honest half. `ruleIdOf` falls back to a slug of the title for rows
 * persisted before `Issue.rule` existed, so on an index written by an older build the
 * whole breakdown is keyed on prose: `possible-hardcoded-secret`, not
 * `security/detect-non-literal-fs-filename`. Those rows still group correctly, but they
 * are not rule ids and must not be rendered as if they were — an operator who copies one
 * into a baseline has copied something a re-index can change.
 */
export interface RuleBreakdownRow extends RuleTally {
  /** No issue behind this row carried a real `rule`: the id came from the title fallback. */
  derived: boolean;
  /** Of the whole list, 0..1 — "one rule is half your findings" is the headline. */
  share: number;
}

export interface RuleBreakdown {
  rows: RuleBreakdownRow[];
  /** What `rows` left out, summarised rather than dropped. */
  restRules: number;
  restFindings: number;
  total: number;
  /** Findings whose rule id is a title slug — 0 on any index written by a current build. */
  derivedFindings: number;
  /** Every tier, including the empty ones: a breakdown that omits "accepted 0" reads as unknown. */
  tiers: Record<FindingGroupKey, number>;
}

export function ruleBreakdown(issues: readonly Issue[], limit = 8): RuleBreakdown {
  const tallies = tallyByRule(issues);

  const derivedIds = new Set<string>();
  let derivedFindings = 0;
  for (const issue of issues) {
    if (issue.rule) continue;
    derivedIds.add(ruleIdOf(issue));
    derivedFindings++;
  }

  const total = issues.length;
  const rest = tallies.slice(limit);
  const tiers: Record<FindingGroupKey, number> = { high: 0, medium: 0, low: 0, accepted: 0 };
  // Through `groupByTier` rather than a second loop over `confidenceTier`, so the tier
  // counts printed here and the groups rendered below cannot disagree about `suppressed`.
  for (const group of groupByTier(issues, "all").groups) tiers[group.key] = group.issues.length;

  return {
    rows: tallies.slice(0, limit).map((t) => ({
      ...t,
      derived: derivedIds.has(t.rule),
      share: total === 0 ? 0 : t.count / total,
    })),
    restRules: rest.length,
    restFindings: rest.reduce((n, t) => n + t.count, 0),
    total,
    derivedFindings,
    tiers,
  };
}

/**
 * Languages whose line comment is `#`. Everything else the indexer reads uses `//`, and
 * a wrong guess is cheap and visible — the user pastes it into a file they have open.
 */
const HASH_COMMENT: Record<string, true> = {
  ".py": true,
  ".rb": true,
  ".sh": true,
  ".bash": true,
  ".zsh": true,
  ".yml": true,
  ".yaml": true,
  ".toml": true,
  ".ini": true,
};

export function commentPrefix(file: string): "#" | "//" {
  const name = file.split("/").pop() ?? file;
  const dot = name.lastIndexOf(".");
  // `dot > 0`, not `>= 0`: a dotfile like `.gitignore` has no extension, it IS one.
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return HASH_COMMENT[ext] ? "#" : "//";
}

/**
 * The placeholder a reader is meant to replace, and it contains no hyphen deliberately:
 * `detect.ts`'s `IGNORE_RE` reads hyphenated words after the directive as further rule
 * ids, so a reason of "test-only fixture" would silently widen the suppression.
 */
export const DEFAULT_IGNORE_REASON = "why this is accepted";

/**
 * `// codegraph-ignore <rule> — <reason>`, the inline acceptance `detect.ts` parses.
 *
 * Copied rather than written by an API: the acceptance belongs in the file, in the same
 * commit and the same review as the code it excuses. A "dismiss" button in this UI would
 * put it in a database no reviewer reads.
 */
export function ignoreComment(
  issue: Pick<Issue, "rule" | "title" | "file">,
  reason: string = DEFAULT_IGNORE_REASON
): string {
  return `${commentPrefix(issue.file)} codegraph-ignore ${ruleIdOf(issue)} — ${reason}`;
}

/**
 * Where a finding lives, as a URL the built-in editor understands.
 *
 * Every surface that lists findings wants this link, and each one that built the query
 * string by hand was one more place that could forget to encode the path — a file called
 * `a+b.ts` or `docs/what?.md` arrives at the editor as a different file, or as none. The
 * report page and the agent swarm now share the single construction, so the editor's
 * `?file=…&line=…` contract is stated once.
 */
export function editorHref(repoId: string, file: string, line: number): string {
  return `/repos/${repoId}/editor?file=${encodeURIComponent(file)}&line=${line}`;
}

/**
 * `src/a.ts:42`, or a bare `src/a.ts` for a finding about the whole file.
 *
 * Line 1 means "no particular line" throughout the detectors, so printing `:1` would
 * claim a precision the finding does not have and send the reader to the import block.
 */
export function findingLocation(finding: { file: string; line: number }): string {
  return finding.line > 1 ? `${finding.file}:${finding.line}` : finding.file;
}

/**
 * Which findings a fix provider actually claims.
 *
 * WHY THE UI NEEDS THIS BEFORE THE BUTTON IS PRESSED
 *
 * The remediation panel offered "Generate verified fix PR" at full prominence on every
 * repository. On one without an auto-fixable finding it ran for four seconds and returned
 * "no verification gate completed / nothing to patch" — which reads as a failure, and is the
 * product's headline promise coming back empty. The answer was knowable before the click:
 * findings carry a rule, and `FIXERS` declares which rules it handles.
 *
 * TWO SPELLINGS, deliberately both. A finding row persisted before rule ids existed was
 * back-filled as `legacy/<slug-of-title>`, while a freshly detected one carries the
 * detector's own id (`empty-catch`). The provider registry keys on the former. Checking one
 * spelling would under-report on exactly one of those two populations, so this asks the
 * registry about both and takes either.
 *
 * This is a PROXY, and an honest one: it predicts a fixer has work because a detector
 * reported the construct that fixer rewrites. The repo-wide run walks the tree rather than
 * the findings list, so the two could in principle disagree — they do not here, because
 * `detect.ts`'s `empty-catch` pattern and the fixer's `EMPTY_CATCH_RE` are the same
 * construct. A suppressed finding is excluded: the repository has already accepted it.
 */
export function autoFixable(issues: readonly Issue[]): Issue[] {
  return issues.filter(
    (i) => !i.suppressed
      && (fixersForRule(ruleIdOf(i)).length > 0 || fixersForRule(legacyRuleIdFor(i.title)).length > 0),
  );
}

export { findingKey, ruleIdOf };
