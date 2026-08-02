import { describe, expect, it } from "vitest";
import { candidateFor, parseCheck } from "../src/candidate";
import type { FileEdit } from "../src/types";

const edit = (file: string, line: number): FileEdit => ({
  file,
  line,
  before: "x",
  after: null,
  fixer: "f",
  reason: "r",
});

describe("candidateFor", () => {
  it("gives gate 1 one entry per changed FILE, not per edit", () => {
    // syntaxGate dedups by `range.file` and re-reads each one, so per-edit entries would
    // re-parse the same file repeatedly.
    const c = candidateFor([edit("a.ts", 1), edit("a.ts", 9), edit("b.ts", 3)], "p");
    expect(c.edits.map((e) => e.range.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("yields no edits for no edits, so gate 1 reports honestly", () => {
    expect(candidateFor([], "p").edits).toHaveLength(0);
  });

  it("carries the provider id through", () => {
    // A record that calls a targeted single-finding fix `legacy-batch` misdescribes it.
    expect(candidateFor([edit("a.ts", 1)], "remove-debug-output").providerId).toBe(
      "remove-debug-output"
    );
  });
});

describe("parseCheck", () => {
  it("accepts a valid file", () => {
    expect(parseCheck("a.ts", "export const x = 1;\n").ok).toBe(true);
  });

  it("rejects an unbalanced brace", () => {
    expect(parseCheck("a.ts", "function f() {\n").ok).toBe(false);
  });

  it.each([
    // MEASURED against the bracket-balance scanner this replaced, by running it from git
    // history — not assumed. It caught 3 of these 5 and MISSED the two marked below, both of
    // which are perfectly balanced and therefore invisible to a depth counter.
    ["a stray closing paren", "const x = 1);"],
    ["an unterminated string", 'const s = "abc;\nexport const y = 1;'],
    ["a malformed arrow", "const f = (=> 1;"],
    ["an else with no if — MISSED by bracket balance", "else { y(); }"],
    ["a keyword where an expression belongs — MISSED by bracket balance", "const x = = 1;"],
  ])("rejects %s", (_name, src) => {
    // THE REASON THIS REPLACED THE OLD CHECK. The web executor injected a hand-rolled
    // bracket-balance scanner, conceding in a comment that it was "deliberately NOT a full
    // parser". The honest size of the gap is 2 of these 5 — real, and smaller than
    // "it missed everything". A balanced-but-invalid file is exactly what deleting a line
    // tends to produce, so the proxy was weakest where gate 1 matters most.
    expect(parseCheck("a.ts", src).ok).toBe(false);
  });

  it("reports the file and line of the first error", () => {
    const r = parseCheck("a.ts", "export const x = 1;\nconst y = = 2;\n");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^a\.ts:2 /);
  });

  it("passes non-JS files rather than claiming a parse it cannot do", () => {
    // Python is fixable (`print` removal) and there is no Python parser in this process.
    // Returning ok is honest; gate 1's reason records which files were actually re-parsed.
    expect(parseCheck("a.py", "def f(:\n").ok).toBe(true);
  });

  it("handles TSX", () => {
    expect(parseCheck("a.tsx", "export const C = () => <div>hi</div>;\n").ok).toBe(true);
    expect(parseCheck("a.tsx", "export const C = () => <div>hi</span>;\n").ok).toBe(false);
  });
});
