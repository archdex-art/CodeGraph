import { Linter } from "eslint";
import security from "eslint-plugin-security";
import tsParser from "@typescript-eslint/parser";

/**
 * AST-based security detector layer, additional to (not a replacement for)
 * indexer.ts's hand-rolled line-regex RULES. The regexes are fast and catch
 * the obvious cases (eval, hardcoded secrets) but are blind to whole classes
 * of real vulnerability that only an AST can see reliably — ReDoS-vulnerable
 * regex literals, dynamic `fs`/`require` paths built from variables, weak
 * (non-cryptographic) randomness, indirect eval, etc. `eslint-plugin-security`
 * has purpose-built, battle-tested rules for exactly these patterns.
 *
 * Uses ESLint's low-level `Linter` API directly (no `.eslintrc`, no project
 * config, no filesystem I/O) so we lint arbitrary, untrusted repo content by
 * string alone — the target repo's own ESLint setup (if any) is irrelevant
 * and never touched.
 */

const JS_EXTS: Record<string, true> = { ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true };

// Curated subset: excludes security/detect-object-injection (extremely high
// false-positive rate on ordinary `obj[key]` access — most real projects
// disable it outright) and security/detect-no-csrf-before-method-override
// (an Express middleware-ordering rule that can't be evaluated from a single
// file in isolation). Each remaining rule has a low, well-understood FP rate
// and flags a genuinely distinct vulnerability class from the regex RULES.
const RULE_META: Record<string, { title: string; severity: number; confidence: number }> = {
  "security/detect-unsafe-regex": { title: "ReDoS-vulnerable regular expression", severity: 3, confidence: 0.85 },
  "security/detect-non-literal-regexp": { title: "Regular expression built from a variable", severity: 2, confidence: 0.7 },
  "security/detect-non-literal-fs-filename": { title: "Filesystem path built from a variable", severity: 3, confidence: 0.7 },
  "security/detect-non-literal-require": { title: "Dynamic require() path", severity: 3, confidence: 0.7 },
  "security/detect-eval-with-expression": { title: "Indirect/computed eval()", severity: 5, confidence: 0.9 },
  "security/detect-pseudoRandomBytes": { title: "Weak (non-cryptographic) randomness", severity: 3, confidence: 0.9 },
  "security/detect-child-process": { title: "Dynamic child_process invocation", severity: 3, confidence: 0.75 },
  "security/detect-buffer-noassert": { title: "Unsafe Buffer read/write (noAssert)", severity: 3, confidence: 0.85 },
  "security/detect-new-buffer": { title: "Deprecated, unsafe `new Buffer()`", severity: 2, confidence: 0.9 },
  "security/detect-disable-mustache-escape": { title: "Disabled template auto-escaping (XSS risk)", severity: 4, confidence: 0.85 },
};

const RULES_CONFIG = Object.fromEntries(Object.keys(RULE_META).map((id) => [id, "warn" as const]));

let linter: Linter | null = null;
function getLinter(): Linter {
  if (!linter) linter = new Linter();
  return linter;
}

const FLAT_CONFIG = [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022 as const,
      sourceType: "module" as const,
    },
    plugins: { security },
    rules: RULES_CONFIG,
  },
];

export interface EslintSecurityFinding {
  line: number;
  title: string;
  severity: number;
  confidence: number;
}

/**
 * Lints one file's in-memory text with the curated security rule set.
 * Returns [] (never throws) for unsupported extensions, unparseable content,
 * or any linter-internal error — a lint failure on one file must never abort
 * indexing the rest of the workspace.
 */
export function lintForSecurity(text: string, ext: string, maxFindings = 10): EslintSecurityFinding[] {
  if (!JS_EXTS[ext]) return [];
  try {
    const filename = `file${ext}`;
    // eslint-plugin-security ships no first-party types and doesn't precisely
    // match ESLint's strict `Linter.Plugin`/`ConfigObject` shape -- verified
    // correct against the real runtime API (see this module's test coverage).
    const messages = getLinter().verify(text, FLAT_CONFIG as Linter.Config[], filename);
    const out: EslintSecurityFinding[] = [];
    for (const m of messages) {
      if (!m.ruleId) continue;
      const meta = RULE_META[m.ruleId];
      if (!meta) continue;
      out.push({ line: Math.max(1, m.line || 1), title: meta.title, severity: meta.severity, confidence: meta.confidence });
      if (out.length >= maxFindings) break;
    }
    return out;
  } catch {
    // Malformed/unparseable file (e.g. non-standard syntax the parser can't
    // handle) -- degrade gracefully, same discipline as the tree-sitter path.
    return [];
  }
}
