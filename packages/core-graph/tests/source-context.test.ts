import { describe, expect, it } from "vitest";
import { contextAt, lexicalSpans, spansFor, syntacticSpans } from "../src/index";

/**
 * Context classification, and the bug that made it dangerous.
 *
 * The first implementation drove a raw `ts.createScanner` in a bare `while (scan())` loop. That
 * loop cannot call `rescanTemplateToken` after a `TemplateHead`, nor `reScanSlashToken` to
 * settle regex-versus-division, so it desynchronises at the first `${...}` or `/` and
 * mis-tokenises the rest of the file. Measured against the parser over 4,783 sampled positions
 * here: **1,125 (23.5%) were plain code reported as `string`**, which SUPPRESSES findings.
 *
 * These cases are the desync shapes, and each one fails on the scanner implementation.
 */
const at = (src: string, needle: string, ext = ".ts") =>
  contextAt(syntacticSpans(src, ext), src.indexOf(needle));

describe("syntacticSpans", () => {
  it("classifies plain code, comments and strings", () => {
    const src = 'const a = 1; // note\nconst b = "text";\n';
    expect(at(src, "const a")).toBe("code");
    expect(at(src, "note")).toBe("comment");
    expect(at(src, "text")).toBe("string");
  });

  it("keeps classifying code AFTER a template literal with a substitution", () => {
    // The desync case. `${` forces a rescan the naive loop never performs, so everything
    // beyond it was reported as `string`.
    const src = "const t = `a${x}b`;\nprocess.exitCode = 1;\n";
    expect(at(src, "process.exitCode")).toBe("code");
  });

  it("treats a template substitution as CODE, not string", () => {
    // `${userInput}` is exactly the interesting spot; marking the whole template as string
    // would blind every rule inside it.
    const src = "const q = `SELECT * FROM ${table}`;\n";
    expect(at(src, "table")).toBe("code");
    expect(at(src, "SELECT")).toBe("string");
  });

  it("keeps classifying code after a regex literal", () => {
    // `/` is division or a regex opener depending on parse state; the scanner guessed.
    const src = "const re = /ab+/g;\nconst after = 2;\n";
    expect(at(src, "const after")).toBe("code");
  });

  it("handles a nested template inside a substitution", () => {
    const src = "const t = `a${`b${c}d`}e`;\nconst after = 1;\n";
    expect(at(src, "const after")).toBe("code");
    expect(at(src, "c}")).toBe("code");
  });

  it("classifies a trailing comment after the last statement", () => {
    // Blank lines matter: with the comment on the very next line it is still reachable as the
    // statement's trailing trivia, so the EOF path is never exercised and dropping it looks
    // harmless. Separated, the comment hangs off the EOF token alone.
    const src = "const a = 1;\n\n\n// far trailing note\n";
    expect(at(src, "far trailing")).toBe("comment");
  });

  it("classifies correctly when spans are discovered out of source order", () => {
    /**
     * `walk` records a node's TRAILING comment before recursing into its children, so a
     * comment after a function is pushed ahead of a string inside it. `contextAt` binary
     * searches, which silently returns wrong answers on an unsorted array - and every
     * one-line fixture here happens to be discovered in order, so the sort looked optional.
     */
    // The comment must be on the SAME line as the closing brace. On its own line it is
    // discovered through the EOF token, which `forEachChild` visits last - so the spans come
    // out already sorted and the missing sort is invisible.
    const src = 'function f() {\n  const s = "inner";\n} // after the function\n';
    expect(at(src, "inner")).toBe("string");
    expect(at(src, "after the function")).toBe("comment");
    expect(at(src, "function f")).toBe("code");
  });

  it("returns no spans for a language the parser does not cover", () => {
    // Python: callers must treat every position as code rather than guess. A wrong span here
    // suppresses a real finding.
    expect(syntacticSpans("# TODO: x\ny = 'z'\n", ".py")).toEqual([]);
  });

  it("does not throw on malformed source", () => {
    // Runs over every file on every index, including half-written ones.
    expect(() => syntacticSpans("const a = `unterminated\n", ".ts")).not.toThrow();
  });
});

/**
 * The lexical fallback, and the false-positive hole it closes.
 *
 * `syntacticSpans` returns `[]` outside the TS family, and `detect.ts` reads an empty span
 * list as "everything is code" — so `context` was a no-op on every non-TS language. Measured
 * before the fix: a Python file whose only content was a docstring reading "an interactive
 * eval() is available" and a string containing "# TODO" produced TWO findings, one of them
 * `Use of eval()` at severity 5, where byte-identical TypeScript produced none.
 *
 * Both directions are tested, because the module's own comment is right that a WRONG span is
 * worse than no span: every case below that asserts `"code"` is guarding a real finding
 * against being silently swallowed.
 */
const lexAt = (src: string, needle: string, ext: string) =>
  contextAt(lexicalSpans(src, ext), src.indexOf(needle));

describe("lexicalSpans", () => {
  it("classifies Python comments, strings and docstrings", () => {
    const src = '# note\nvalue = "text"\ndef f():\n    """doc"""\n    return 1\n';
    expect(lexAt(src, "note", ".py")).toBe("comment");
    expect(lexAt(src, "text", ".py")).toBe("string");
    expect(lexAt(src, "doc", ".py")).toBe("string");
    expect(lexAt(src, "value", ".py")).toBe("code");
    expect(lexAt(src, "return 1", ".py")).toBe("code");
  });

  it("classifies the C-like family", () => {
    for (const ext of [".go", ".java", ".cs", ".rs", ".cpp"]) {
      const src = 'int x = 1; // note\nchar *s = "text";\n/* block */\nint y = 2;\n';
      expect(lexAt(src, "note", ext)).toBe("comment");
      expect(lexAt(src, "text", ext)).toBe("string");
      expect(lexAt(src, "block", ext)).toBe("comment");
      expect(lexAt(src, "int y", ext)).toBe("code");
    }
  });

  it("does not let an apostrophe in a comment swallow the rest of the file", () => {
    // The failure that would turn this fix into the false negatives the module warns about:
    // treating `don't` as an unterminated string hides every finding below it.
    const src = "# don't do this\nos.system(cmd)\n";
    expect(lexAt(src, "os.system", ".py")).toBe("code");
  });

  it("does not let an unterminated single-quoted string run past its line", () => {
    const src = "value = 'oops\nos.system(cmd)\n";
    expect(lexAt(src, "os.system", ".py")).toBe("code");
  });

  it("honours escapes rather than closing early", () => {
    const src = 'value = "a\\"b"\nos.system(cmd)\n';
    expect(lexAt(src, "os.system", ".py")).toBe("code");
  });

  it("keeps a triple-quoted docstring as ONE span across lines", () => {
    const src = 'def f():\n    """line one\n    line two"""\n    return eval(x)\n';
    expect(lexAt(src, "line two", ".py")).toBe("string");
    expect(lexAt(src, "eval(x)", ".py")).toBe("code");
  });

  it("returns nothing for a language it has no rules for, so callers fail open", () => {
    expect(lexicalSpans("# TODO\n", ".unknownext")).toEqual([]);
  });

  it("does not throw on unterminated constructs", () => {
    expect(() => lexicalSpans('s = "unterminated\n', ".py")).not.toThrow();
    expect(() => lexicalSpans("/* unterminated\n", ".go")).not.toThrow();
  });
});

describe("spansFor", () => {
  it("parses the TS family and lexes everything else", () => {
    expect(contextAt(spansFor('const a = "x"; // n', ".ts"), 12)).toBe("string");
    expect(contextAt(spansFor('a = "x"  # n', ".py"), 5)).toBe("string");
    // No rules, no spans: every position stays `code` and nothing is suppressed.
    expect(spansFor("anything", ".bin")).toEqual([]);
  });
});
