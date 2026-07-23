import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Dimension, Issue } from "../types";
import { lintForSecurity } from "../eslintSecurity";
import { CODE_EXTS } from "./constants";
import type { ScannedFile } from "./scan";
import { YIELD_EVERY, yieldToEventLoop } from "./util";

interface Rule {
  re: RegExp;
  dimension: Dimension;
  severity: number;
  confidence?: number;
  title: string;
  exts?: Record<string, true>;
  validate?: (line: string, m: RegExpExecArray) => boolean;
}

// A real secret never contains a literal "..." ellipsis or matches a common
// placeholder word — those are documentation/example conventions.
const PLACEHOLDER_SECRET_RE = /^(\.{3,}|x{4,}|\*{4,}|your[-_ ]?\w*|example\w*|placeholder\w*|changeme|insert[-_ ]?\w*|redacted|dummy|fake|sample|todo|<.*>|\{\{.*\}\})$/i;
function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRET_RE.test(value) || value.includes("...");
}

// Heuristic, language-agnostic-ish defect/risk rules.
const RULES: Rule[] = [
  { re: /\beval\s*\(/, dimension: "security", severity: 5, confidence: 0.95, title: "Use of eval()" },
  { re: /child_process|os\.system\(|subprocess\.(call|run|Popen)\(/, dimension: "security", severity: 3, confidence: 0.85, title: "Shell/process execution" },
  {
    re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"]([^'"]{6,})['"]/i,
    dimension: "security", severity: 5, confidence: 0.8, title: "Possible hardcoded secret",
    validate: (_line, m) => !isPlaceholderSecret(m[2]),
  },
  { re: /https?:\/\/[^"'\s]*(?<![\w.])(localhost|127\.0\.0\.1)/, dimension: "security", severity: 2, confidence: 0.9, title: "Hardcoded local URL" },
  { re: /\bdangerouslySetInnerHTML\b|innerHTML\s*=/, dimension: "security", severity: 3, confidence: 0.95, title: "Raw HTML injection sink" },
  { re: /SELECT\s+.+\+|query\(\s*['"`].*\$\{/i, dimension: "security", severity: 4, confidence: 0.7, title: "Possible SQL string concatenation" },

  { re: /\bconsole\.(log|debug)\b|^\s*print\(/m, dimension: "correctness", severity: 1, confidence: 1.0, title: "Leftover debug output" },
  { re: /\bdebugger\b/, dimension: "correctness", severity: 2, confidence: 1.0, title: "debugger statement" },
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/, dimension: "correctness", severity: 3, confidence: 0.9, title: "Empty catch block" },
  { re: /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/, dimension: "maintainability", severity: 1, confidence: 1.0, title: "TODO/FIXME marker" },
  { re: /@ts-(ignore|nocheck)|# type: ignore|eslint-disable/, dimension: "maintainability", severity: 2, confidence: 1.0, title: "Suppressed checker" },
  { re: /:\s*any\b|\bas\s+any\b/, dimension: "correctness", severity: 1, confidence: 1.0, title: "Untyped `any`", exts: { ".ts": true, ".tsx": true } },
];

let _issueSeq = 0;

/** Reset the per-run issue-id sequence. Call once at the start of indexRepo(). */
export function resetIssueSeq() {
  _issueSeq = 0;
}

function mkIssue(dim: Dimension, sev: number, title: string, file: string, line: number, br: number, conf?: number, churn?: number): Issue {
  return { id: `iss_${_issueSeq++}`, dimension: dim, severity: sev, confidence: conf, title, file, line, blastRadius: br, churn: churn ?? 1 };
}

export async function analyzeFiles(files: ScannedFile[], fanIn: Map<string, number>, churnByFile: Map<string, number>): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (let idx = 0; idx < files.length; idx++) {
    if (idx > 0 && idx % YIELD_EVERY === 0) await yieldToEventLoop();
    const f = files[idx];
    if (!f.text) continue;
    const br = 1 + (fanIn.get(f.rel) || 0); // blast radius from graph fan-in
    const ch = churnByFile.get(f.rel) || 1;
    const lines = f.text.split("\n");
    for (const rule of RULES) {
      if (rule.exts && !rule.exts[f.ext]) continue;
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = rule.re.exec(lines[i]);
        if (m && (!rule.validate || rule.validate(lines[i], m))) {
          issues.push(mkIssue(rule.dimension, rule.severity, rule.title, f.rel, i + 1, br, rule.confidence, ch));
          hits++;
          if (hits >= 5) break; // bounded top-N (5) hits per rule per file
        }
      }
    }
    // AST-based security detector layer (eslint-plugin-security), catches
    // vulnerability classes the line-regex RULES above are structurally blind
    // to (ReDoS regex literals, dynamic fs/require paths, weak randomness, ...).
    for (const f2 of lintForSecurity(f.text, f.ext)) {
      issues.push(mkIssue("security", f2.severity, f2.title, f.rel, f2.line, br, f2.confidence, ch));
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

/** Extract recent commit counts per file. */
export function computeChurn(root: string): Map<string, number> {
  const churn = new Map<string, number>();
  try {
    const out = execSync(`git log --since="6.months.ago" --name-only --format=""`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) churn.set(f, (churn.get(f) || 0) + 1);
    }
  } catch {
    // Not a git repo, or git not installed
  }
  return churn;
}

/** Dependency hygiene from manifests actually present in the repo. */
export function analyzeDependencies(root: string): { issues: Issue[]; count: number; depsList: string[] } {
  const depsList: string[] = [];
  const issues: Issue[] = [];
  let count = 0;

  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      count = Object.keys(deps).length;
      depsList.push(...Object.keys(deps));
      for (const [name, range] of Object.entries(deps)) {
        const v = String(range);
        if (v === "*" || v === "latest" || v.startsWith("http") || v.startsWith("git")) {
          issues.push(mkIssue("dependency_hygiene", 3, `Unpinned dependency: ${name} (${v})`, "package.json", 1, 2, 1.0));
        } else if (/^[~^]?0\./.test(v)) {
          issues.push(mkIssue("dependency_hygiene", 1, `Pre-1.0 dependency: ${name} (${v})`, "package.json", 1, 1, 1.0));
        }
      }
      if (!existsSync(path.join(root, "package-lock.json")) &&
          !existsSync(path.join(root, "pnpm-lock.yaml")) &&
          !existsSync(path.join(root, "yarn.lock"))) {
        issues.push(mkIssue("dependency_hygiene", 2, "No lockfile committed", "package.json", 1, 2, 1.0));
      }
    } catch {
      /* ignore malformed */
    }
  }

  const reqPath = path.join(root, "requirements.txt");
  if (existsSync(reqPath)) {
    try {
      const lines = readFileSync(reqPath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      count += lines.length;
      for (const l of lines) {
        const m = l.match(/^([A-Za-z0-9_-]+)/);
        if (m) depsList.push(m[1]);
        if (!/[=<>~]/.test(l)) {
          issues.push(mkIssue("dependency_hygiene", 2, `Unpinned dependency: ${l.trim()}`, "requirements.txt", 1, 1, 1.0));
        }
      }
    } catch {
      /* ignore */
    }
  }

  return { issues, count, depsList };
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
