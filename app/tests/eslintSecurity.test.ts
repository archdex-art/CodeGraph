import { describe, it, expect } from "vitest";
import { lintForSecurity } from "@/lib/eslintSecurity";
import { indexRepo } from "@/lib/indexer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The 6 existing hand-rolled RULES in indexer.ts (eval, shell exec, hardcoded
// secret, hardcoded local URL, HTML injection sink, SQL concat) have zero
// coverage for ReDoS-vulnerable regex literals -- this is a distinct
// vulnerability class only an AST-based detector can reliably catch.
const REDOS_CODE = `
export function isValidId(id: string): boolean {
  const re = /^(a+)+$/;
  return re.test(id);
}
`;

describe("lintForSecurity (Task 6.15)", () => {
  it("catches a ReDoS-vulnerable regex literal that the line-regex RULES structurally cannot", () => {
    const findings = lintForSecurity(REDOS_CODE, ".ts");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].title).toMatch(/ReDoS/i);
    expect(findings[0].line).toBe(3);
  });

  it("catches weak (non-cryptographic) randomness via pseudoRandomBytes", () => {
    const code = `import crypto from "crypto";\nexport function token() { return crypto.pseudoRandomBytes(16); }`;
    const findings = lintForSecurity(code, ".js");
    expect(findings.some((f) => /randomness/i.test(f.title))).toBe(true);
  });

  it("returns [] for non-JS/TS extensions without attempting to parse", () => {
    expect(lintForSecurity(REDOS_CODE, ".py")).toEqual([]);
  });

  it("degrades gracefully (returns [], never throws) on unparseable content", () => {
    expect(() => lintForSecurity("this is not { valid syntax at all (((", ".ts")).not.toThrow();
    expect(lintForSecurity("this is not { valid syntax at all (((", ".ts")).toEqual([]);
  });

  it("caps findings at maxFindings per file", () => {
    const manyUnsafeRegexes = Array.from({ length: 20 }, (_, i) => `const r${i} = /^(a+)+${i}$/;`).join("\n");
    const findings = lintForSecurity(manyUnsafeRegexes, ".ts", 5);
    expect(findings.length).toBeLessThanOrEqual(5);
  });
});

describe("indexRepo: ESLint security layer wired into the real pipeline", () => {
  it("surfaces a ReDoS finding end-to-end through indexRepo, alongside the existing regex-rule findings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eslint-sec-e2e-"));
    try {
      writeFileSync(
        path.join(dir, "validate.ts"),
        [
          "export function isValidId(id: string): boolean {",
          "  const re = /^(a+)+$/;", // ReDoS -- only the ESLint layer catches this
          "  return re.test(id);",
          "}",
          "export function run() { eval('1+1'); }", // existing regex RULES still catch this
        ].join("\n"),
        "utf8"
      );
      const result = indexRepo(dir);
      const titles = result.issues.map((i) => i.title);
      expect(titles.some((t) => /ReDoS/i.test(t))).toBe(true);
      expect(titles).toContain("Use of eval()");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
