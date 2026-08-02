import ts from "typescript";
import {
  callAt,
  classifyTaint,
  contextAt,
  spansFor,
  tierForExt,
  type SourceContext,
  type TaintQuery,
  type TaintVerdict,
} from "@codegraph/core-graph";
import {
  YIELD_EVERY,
  throwIfAborted,
  yieldToEventLoop,
  type Dimension,
  type Issue,
  type PipelineContext,
  type ScannedFile,
} from "@codegraph/analysis-model";
import { CODE_EXTS } from "@codegraph/analysis-model";
import { HITS_PER_RULE_PER_FILE } from "@codegraph/score-engine";
import { lintForSecurity } from "./eslintSecurity";

/**
 * Detection: source text in, findings out (LLD §13's `detect-engine` slice).
 *
 * Everything that decides WHETHER something is a finding and HOW MUCH to believe it lives here
 * - the rule table, the syntactic context gate, the taint verdict, the analysis tier, and the
 * value-shape signal on secrets. What it deliberately does not contain is the score: that is
 * `@codegraph/score-engine`, and keeping the two apart is what stops a rule being tuned to
 * move a number.
 *
 * The confidence policies are grouped rather than scattered because they COMPOSE. A finding in
 * a Python file, from a rule whose value does not look machine-generated, is discounted twice,
 * and both discounts multiply into `expectedHarm`. Reading them in one place is the only way to
 * see the product of those factors.
 */

interface Rule {
  re: RegExp;
  dimension: Dimension;
  severity: number;
  confidence?: number;
  title: string;
  exts?: Record<string, true>;
  validate?: (line: string, m: RegExpExecArray) => boolean;
  /**
   * Multiplier applied to this match's confidence. Separate from `validate`, which DELETES the
   * finding: a weak signal should move the weight, not silence the report.
   */
  adjust?: (m: RegExpExecArray) => number;
  /**
   * Syntactic contexts in which this rule can legitimately fire. Defaults to `["code"]`.
   *
   * This is the cheap half of PLAN.md P5's "route the regexes through structural rules": not a
   * graph-shape query yet, but the position class the match must be in. Measured across every
   * match, **35% on express and 64% on this repository** were in a context where the rule
   * cannot be true - `eval(` inside a doc comment, `console.log` inside a string.
   *
   * It is per-rule and NOT "strip comments and strings", because the correct context differs:
   * a `TODO` marker belongs in a comment and is noise anywhere else; `@ts-ignore` can only
   * ever be a comment; a hardcoded `localhost` URL is necessarily a string literal. Blanket
   * stripping would have deleted three rules' true positives outright.
   */
  context?: readonly SourceContext[];
}

const DEFAULT_CONTEXT: readonly SourceContext[] = ["code"];

// A real secret never contains a literal "..." ellipsis or matches a common
// placeholder word — those are documentation/example conventions.
const PLACEHOLDER_SECRET_RE = /^(\.{3,}|x{4,}|\*{4,}|your[-_ ]?\w*|example\w*|placeholder\w*|changeme|insert[-_ ]?\w*|redacted|dummy|fake|sample|todo|<.*>|\{\{.*\}\})$/i;
/**
 * Is this value shaped like a machine-generated credential?
 *
 * Found by running CodeGraph on CodeGraph. "Possible hardcoded secret" dominated the top of
 * our own findings and drove the security dimension to 12, and every one was wrong. Two
 * classes, both from real code in this repository:
 *
 *   apps/web/src/lib/settings.ts:71  anthropicApiKey: "assistant.anthropicApiKey"
 *   apps/web/tests/redact.test.ts:13 anthropicApiKey: "sk-ant-BAD-KEY"
 *
 * The first is a settings PATH, not a value. The second is a test fixture.
 *
 * Entropy was tried first and does not separate them: the fixture
 * `sk-ant-SCOPED-BUT-VALID-KEY` scores H=4.18, ABOVE the real-shaped `AKIAIOSFODNN7EXAMPLE`
 * (3.68) and a 40-char hex digest (3.83). What does separate them on that sample is a digit -
 * generated credentials contain them (base64, hex, AWS ids, GitHub tokens all do) and
 * hand-written identifiers usually do not.
 *
 * Ten examples is a small sample and the rule is stated as a weak signal accordingly: it
 * DOWNGRADES rather than rejects, because `correcthorsebatterystaple` is a real secret with no
 * digits in it. A long value passes regardless, since length alone makes a generated secret
 * plausible.
 */
const CONFIG_PATH_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;

function looksLikeCredential(value: string): boolean {
  if (CONFIG_PATH_RE.test(value)) return false; // `assistant.anthropicApiKey` is a key, not a value
  return /\d/.test(value) || value.length >= 32;
}

/** Weak-signal discount for a value that does not look machine-generated. */
const WEAK_SECRET_FACTOR = 0.25;

/**
 * Placeholder WORDS appearing as whole tokens, and character runs no generator produces.
 *
 * Added from the precision audit's measured failures, not from imagination. "Possible hardcoded
 * secret" scored **0/8** — every match was a fixture or a documentation placeholder:
 * `sk-test-key`, `test-secret-for-fleet-graph`, `unused`, `foobar`,
 * `ghp_0123456789abcdefghijABCDEFGHIJ`.
 *
 * The token boundary is deliberate: `AKIAIOSFODNN7EXAMPLE` contains "EXAMPLE" but is preceded
 * by `7`, so it is not a token and the value is still reported. Requiring a non-alphanumeric
 * boundary is what separates a placeholder word from a coincidental substring.
 *
 * **This deletes findings, so it carries false-negative risk**, and the risk is real: a genuine
 * key issued for a test account can contain "test". The trade is deliberate — a rule that
 * reports eight fixtures buries the one real credential among them, and the loud case is better
 * served by a dedicated high-entropy detector than by this one crying wolf. Recorded rather
 * than hidden.
 */
const PLACEHOLDER_TOKEN_RE =
  /(?:^|[^A-Za-z0-9])(?:test|testing|unused|foobar|dummy|fake|sample|example|placeholder|changeme|secret|password)(?:[^A-Za-z0-9]|$)/i;

/** Runs no credential generator emits; `ghp_0123456789abcdefghij...` is a hand-typed stub. */
const SYNTHETIC_RUN_RE = /0123456789|abcdefghij|ABCDEFGHIJ|qwerty|aaaaaa/;

function isPlaceholderSecret(value: string): boolean {
  return (
    PLACEHOLDER_SECRET_RE.test(value) ||
    value.includes("...") ||
    PLACEHOLDER_TOKEN_RE.test(value) ||
    SYNTHETIC_RUN_RE.test(value)
  );
}

/**
 * Is `line` a genuine marker/directive, or one QUOTED as an example?
 *
 * The second refinement the precision audit forced. Requiring the marker to follow a comment
 * opener removed prose like "reduce every TODO in a file", but left a narrower class: a comment
 * that quotes a marker inside backticks as an example. Two of the three survivors were exactly
 * that - in this file's own documentation of these rules.
 *
 * Markdown inline-code parity settles it: an odd number of backticks before the match means it
 * is inside an unclosed span, so it is being shown rather than left. Every match is checked,
 * not just the first, because a comment can quote an example AND leave a real marker on the
 * same line.
 */
const TODO_MARKER_RE = /(?:\/\/|\/\*+|^\s*\*|#)\s*(?:TODO|FIXME|HACK|XXX)\b/;
const SUPPRESSION_RE = /(?:\/\/|\/\*+|^\s*\*|#)\s*(?:@ts-(?:ignore|nocheck)|eslint-disable|type:\s*ignore)\b/;

function markerNotQuoted(re: RegExp, line: string): boolean {
  const scan = new RegExp(re.source, "g");
  for (let m: RegExpExecArray | null; (m = scan.exec(line)); ) {
    let ticks = 0;
    for (let i = 0; i < m.index; i++) if (line[i] === "`") ticks++;
    if (ticks % 2 === 0) return true;
    if (m.index === scan.lastIndex) scan.lastIndex++;
  }
  return false;
}

// Heuristic, language-agnostic-ish defect/risk rules.
const RULES: Rule[] = [
  { re: /\beval\s*\(/, dimension: "security", severity: 5, confidence: 0.95, title: "Use of eval()" },
  { re: /child_process|os\.system\(|subprocess\.(call|run|Popen)\(/, dimension: "security", severity: 3, confidence: 0.85, title: "Shell/process execution" },
  {
    re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"]([^'"]{6,})['"]/i,
    dimension: "security", severity: 5, confidence: 0.8, title: "Possible hardcoded secret",
    validate: (_line, m) => !isPlaceholderSecret(m[2]),
    adjust: (m) => (looksLikeCredential(m[2]) ? 1 : WEAK_SECRET_FACTOR),
  },
  // A hardcoded URL IS a string literal; in a comment it is an example, not a config value.
  { re: /https?:\/\/[^"'\s]*(?<![\w.])(localhost|127\.0\.0\.1)/, dimension: "security", severity: 2, confidence: 0.9, title: "Hardcoded local URL", context: ["string", "code"] },
  { re: /\bdangerouslySetInnerHTML\b|innerHTML\s*=/, dimension: "security", severity: 3, confidence: 0.95, title: "Raw HTML injection sink" },
  // The SELECT half matches inside the query string; the `query(` half matches in code.
  { re: /SELECT\s+.+\+|query\(\s*['"`].*\$\{/i, dimension: "security", severity: 4, confidence: 0.7, title: "Possible SQL string concatenation", context: ["code", "string"] },

  { re: /\bconsole\.(log|debug)\b|^\s*print\(/m, dimension: "correctness", severity: 1, confidence: 1.0, title: "Leftover debug output" },
  /**
   * A debugger STATEMENT, not the word.
   *
   * Scored **0/4** on the held-out Python corpus (`docs/design/PRECISION_PROTOCOL.md` §8) -
   * every match was docstring prose ("an interactive debugger will be shown") or a CLI option
   * string (`"--debugger/--no-debugger"`). Python has no `debugger` keyword, so on a Python
   * file a match is prose by construction, and Python is `lexical` tier so no context gate is
   * there to help.
   *
   * Two changes: restricted to the JS/TS family, where the statement exists, and required to be
   * a statement - line start or after `;`/`{`/`}`/a block-comment close, optionally terminated.
   * `const debuggerPort = 9229` no longer matches either.
   *
   * Found only because §8's criteria demanded a Python repository specifically, on the grounds
   * that the lexical tier had never been precision-tested. It was the one place the held-out
   * run found a new failure.
   */
  { re: /(?:^|[;{}]|\*\/)\s*debugger\s*(?:;|$)/, dimension: "correctness", severity: 2, confidence: 1.0, title: "debugger statement",
    exts: { ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true } },
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/, dimension: "correctness", severity: 3, confidence: 0.9, title: "Empty catch block" },
  /**
   * A marker lives in a comment BY DEFINITION, and must FOLLOW the comment opener.
   *
   * The word-boundary form scored **0/4** in the precision audit
   * (`docs/design/PRECISION_PROTOCOL.md`): every match was prose ABOUT TODO handling -
   * "reduce every TODO in a file", "e.g. God files, TODO markers". Restricting the context to
   * comments was necessary and not sufficient, because a comment discussing markers is still a
   * comment.
   *
   * The distinction that works is position: a real marker is the first thing after `//`, `/*`,
   * a JSDoc `*`, or `#`. A mention sits mid-sentence. Trailing markers
   * (`const x = 1; // TODO: later`) still match, because the opener is still immediately before.
   */
  { re: TODO_MARKER_RE, dimension: "maintainability", severity: 1, confidence: 1.0, title: "TODO/FIXME marker", context: ["comment"],
    validate: (line) => markerNotQuoted(TODO_MARKER_RE, line) },
  /**
   * Same failure, same fix. A directive suppresses something only when the compiler reads it as
   * one, which means it follows the comment opener. The audit's single instance was a doc
   * comment EXPLAINING `@ts-ignore` - nothing was suppressed, so the finding's title was simply
   * untrue (protocol rule 5).
   */
  { re: SUPPRESSION_RE, dimension: "maintainability", severity: 2, confidence: 1.0, title: "Suppressed checker", context: ["comment"],
    validate: (line) => markerNotQuoted(SUPPRESSION_RE, line) },
  { re: /:\s*any\b|\bas\s+any\b/, dimension: "correctness", severity: 1, confidence: 1.0, title: "Untyped `any`", exts: { ".ts": true, ".tsx": true } },
];

/**
 * Provenance policy for sink findings (PLAN.md P5 item 2).
 *
 * `eslint-plugin-security` flags any non-literal argument to a sink. On this repository that
 * is 136 of 200 findings - 68% from one rule - and reading them shows `mkdirSync(dir)` from
 * config, `statSync(full)` inside a directory walk, temp paths in tests. None of it
 * attacker-controlled. The rule cannot tell, because it never asks where the value came from.
 *
 * **Sources are deliberately narrow, and `process.env` is deliberately absent.** Env vars are
 * operator configuration, not attacker input; treating them as a source would re-flag exactly
 * the config-driven paths this is meant to quieten, and the noise would return wearing a
 * taint-analysis badge. `process.argv` IS included: for a CLI it is user input.
 *
 * A function PARAMETER is not a source either. Every function taking an argument would light
 * up, and cross-function propagation is P5 item 4's job, bounded to depth 3.
 */
const TAINT_QUERY: TaintQuery = {
  sourceRoots: new Set(["req", "request", "ctx"]),
  sourceExpressions: [
    /^process\.argv\b/,
    /^(window\.)?location\.(search|hash|href)\b/,
    /^document\.cookie\b/,
  ],
  // `resolveSafe` is this repository's containment primitive (packages/fsx/src/workspace.ts).
  sanitizers: new Set(["resolveSafe", "escapeHtml", "sanitize", "encodeURIComponent"]),
};

const TS_FAMILY_EXT: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
};

/**
 * Taint modulates CONFIDENCE; it never deletes a finding.
 *
 * Deleting would convert an incomplete source list into silent false negatives - the failure
 * mode a security tool cannot afford, and one nobody would notice. Downgrading keeps the
 * finding visible and lets it weigh correctly, because `confidence` now multiplies into
 * `expectedHarm`: an untraced sink contributes about a third of what it used to, and a
 * genuinely tainted one outranks everything around it. The two changes compose by design.
 */
function adjustForTaint(base: number, verdict: TaintVerdict): number {
  switch (verdict) {
    // Reached a source with nothing cleaning it. This is the finding the rule was written for.
    case "tainted":
      return Math.min(0.95, base * 1.35);
    // A source, then a sanitizer. Reported, but it should sit near the bottom of the list.
    case "sanitized":
      return Math.max(0.05, base * 0.2);
    // No source found inside this function. Usually internal, sometimes a caller's argument
    // we cannot see yet - hence downgraded, not dropped.
    case "untraced":
      return Math.max(0.1, base * 0.35);
  }
}

/**
 * How far a `lexical`-tier finding's confidence is cut (HLD §8.3).
 *
 * A regex hit in a file nobody parsed might be in a comment, a string, or real code - the
 * distinction the context gate makes for TypeScript and cannot make for Python. Measured on
 * express and this repository, 35-64% of raw regex matches sit in a context where the rule
 * cannot hold, so a little over half is the honest discount for not knowing which.
 *
 * Not zero, and not a filter: the finding may well be real, and hiding it would trade visible
 * noise for silent blindness on every non-TypeScript file in the repository.
 */
const LEXICAL_CONFIDENCE_FACTOR = 0.45;

/** Absent confidence means "unqualified", so it stays unqualified rather than becoming 0. */
function scaleConfidence(base: number | undefined, factor: number): number | undefined {
  if (base === undefined) return undefined;
  return factor === 1 ? base : Math.max(0.05, Math.round(base * factor * 1000) / 1000);
}

let _issueSeq = 0;

/**
 * Reset issue ids at the start of a run.
 *
 * Ids are a per-run sequence, so two indexes in one process must not continue each other's
 * numbering - `agents/executor.ts` indexes twice per remediation and compares the results. The
 * counter used to be reset by `indexRepo` touching the variable directly; now that detection is
 * its own package the reset is an explicit part of its contract rather than a shared mutable.
 */
export function resetIssueIds(): void {
  _issueSeq = 0;
}
export function mkIssue(dim: Dimension, sev: number, title: string, file: string, line: number, br: number, conf?: number, churn?: number): Issue {
  return { id: `iss_${_issueSeq++}`, dimension: dim, severity: sev, confidence: conf, title, file, line, blastRadius: br, churn: churn ?? 1 };
}

export async function analyzeFiles(files: ScannedFile[], fanIn: Map<string, number>, churnByFile: Map<string, number>, ctx?: PipelineContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) {
      await yieldToEventLoop();
      throwIfAborted(ctx);
    }
    const f = files[idx];
    if (!f.text) continue;
    const br = 1 + (fanIn.get(f.rel) || 0); // blast radius from graph fan-in
    const ch = churnByFile.get(f.rel) || 1;
    /**
     * HLD §8.3: a `lexical`-tier file was matched by regex alone - no parse, so no idea
     * whether a hit sits in a comment, a string, or running code. The design always said those
     * findings are "marked low-confidence"; nothing did it until now.
     *
     * This is the same boundary as `syntacticSpans`, and deliberately so: the files that get
     * no context gating are exactly the files whose findings cannot be trusted as far.
     */
    const tier = tierForExt(f.ext);
    const tierPenalty = tier === "lexical" ? LEXICAL_CONFIDENCE_FACTOR : 1;
    const lines = f.text.split("\n");
    /**
     * Comment/string ranges for this file, computed ONCE and shared by all 12 rules. Empty for
     * languages the TS scanner does not cover (Python), which makes every position `code` and
     * leaves those files scored exactly as before - see `syntacticSpans`.
     */
    const spans = spansFor(f.text, f.ext);
    // Absolute offset of each line start, so a per-line regex index becomes a file offset.
    const lineStart: number[] = new Array(lines.length);
    for (let i = 0, at = 0; i < lines.length; i++) {
      lineStart[i] = at;
      at += lines[i].length + 1; // +1 for the "\n" removed by split
    }
    for (const rule of RULES) {
      if (rule.exts && !rule.exts[f.ext]) continue;
      const validContexts = rule.context ?? DEFAULT_CONTEXT;
      let emitted = 0;
      let occurrences = 0;
      let firstIssueIndex = -1;
      for (const [lineIndex, line] of lines.entries()) {
        const m = rule.re.exec(line);
        if (!m || (rule.validate && !rule.validate(line, m))) continue;
        // Structural gate. `spans` empty => "code" => unchanged behaviour.
        if (spans.length && !validContexts.includes(contextAt(spans, lineStart[lineIndex] + m.index)))
          continue;
        occurrences++;
        // Keep emitting only up to the cap: the issue list is rendered and
        // stored, so it stays bounded. Counting continues past it so the score
        // can tell 500 matches from 5 (review B3) — scanning the remaining lines
        // is the same regex pass either way, so this costs nothing extra.
        if (emitted < HITS_PER_RULE_PER_FILE) {
          if (firstIssueIndex === -1) firstIssueIndex = issues.length;
          issues.push(
            mkIssue(
              rule.dimension, rule.severity, rule.title, f.rel, lineIndex + 1, br,
              scaleConfidence(rule.confidence, tierPenalty * (rule.adjust?.(m) ?? 1)), ch,
            ),
          );
          emitted++;
        }
      }
      // Volume is recorded once per (rule, file) group, on the first emitted
      // issue. Setting it on all of them would multiply the same excess by the
      // number of emitted markers.
      if (occurrences > HITS_PER_RULE_PER_FILE && firstIssueIndex >= 0) {
        const first = issues[firstIssueIndex];
        if (first) first.occurrences = occurrences;
      }
    }
    // AST-based security detector layer (eslint-plugin-security), catches
    // vulnerability classes the line-regex RULES above are structurally blind
    // to (ReDoS regex literals, dynamic fs/require paths, weak randomness, ...).
    const secFindings = lintForSecurity(f.text, f.ext);
    // Parse once, and only if a sink finding actually needs provenance checking.
    let taintSf: ts.SourceFile | null = null;
    for (const f2 of secFindings) {
      let confidence = f2.confidence;
      if (f2.taintable && TS_FAMILY_EXT[f.ext]) {
        taintSf ??= ts.createSourceFile(f.rel, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const call = callAt(taintSf, f2.line, f2.column);
        const arg = call?.arguments[0];
        if (arg) confidence = adjustForTaint(confidence, classifyTaint(arg, TAINT_QUERY));
      }
      issues.push(mkIssue("security", f2.severity, f2.title, f.rel, f2.line, br, scaleConfidence(confidence, tierPenalty), ch));
    }

    // God-file: very large source file → maintainability penalty scaled by fan-in.
    if (f.loc > 600) {
      issues.push(
        mkIssue("maintainability", f.loc > 1200 ? 4 : 2, `Large file (${f.loc} LOC)`, f.rel, 1, br, 0.9, ch)
      );
    }
  }
  return issues;
}


/** Test integrity: presence/ratio of test files. */
export function analyzeTests(files: ScannedFile[]): Issue[] {
  const code = files.filter((f) => CODE_EXTS[f.ext]);
  if (code.length === 0) return [];
  const tests = code.filter((f) => /(\.|_|\/)(test|spec)/i.test(f.rel) || /(^|\/)tests?\//i.test(f.rel));
  const ratio = tests.length / code.length;
  const issues: Issue[] = [];
  if (tests.length === 0) {
    issues.push(mkIssue("test_integrity", 4, "No test files detected", ".", 1, 3, 0.6));
  } else if (ratio < 0.1) {
    issues.push(mkIssue("test_integrity", 2, `Low test coverage ratio (${(ratio * 100).toFixed(0)}% of code files)`, ".", 1, 2, 0.75));
  }
  return issues;
}


// The renderable file/directory graph moved to `@codegraph/viz` (LLD §13).
