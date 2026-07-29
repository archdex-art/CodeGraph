import { describe, expect, it } from "vitest";
import { fingerprint, normalizeSnippet } from "../src/index";

/**
 * `fingerprint()` is a persisted contract, not an implementation detail: a
 * suppression row IS a fingerprint, so a change in how it is computed silently
 * un-suppresses everything users have already dismissed and resets every
 * baseline. These tests are written to make that change loud.
 *
 * They are grouped by the property being defended rather than by function,
 * because the properties are the contract — "survives a file move" is the thing
 * downstream features rely on, and no single function owns it.
 */

/** Convenience: fingerprint a raw (un-normalised) excerpt. */
const fp = (ruleId: string, scope: string, raw: string): string =>
  fingerprint({ ruleId, scope, normalizedSnippet: normalizeSnippet(raw) });

describe("fingerprint: what must NOT change it", () => {
  it("is deterministic across calls", () => {
    const a = fp("js/no-eval", "handler", "eval(userInput)");
    const b = fp("js/no-eval", "handler", "eval(userInput)");
    expect(a).toBe(b);
  });

  it("ignores the line the finding sits on", () => {
    // There is no line/column input at all — the type makes shifting a finding
    // down the file unrepresentable, which is stronger than asserting equality
    // over two line numbers. This test documents that as intent.
    const shape = { ruleId: "r", scope: "s", normalizedSnippet: "x" };
    expect(Object.keys(shape).sort()).toEqual(["normalizedSnippet", "ruleId", "scope"]);
    expect(fingerprint(shape)).toBe(fingerprint({ ...shape }));
  });

  it("survives a file move when scope is a symbol name", () => {
    // The file path is never an input, so relocating src/db.ts to
    // src/server/db.ts cannot change the identity of a finding inside
    // UserRepo.findByName.
    const before = fp("js/sql-injection", "UserRepo.findByName", 'q("SELECT " + n)');
    const after = fp("js/sql-injection", "UserRepo.findByName", 'q("SELECT " + n)');
    expect(after).toBe(before);
  });

  it("survives a directory move when scope falls back to the file basename", () => {
    // LLD §2.1: scope is the enclosing symbol, or the BASENAME if there is
    // none. Basename, not path, precisely so a directory move is not a new
    // finding.
    const before = fp("generic/todo-marker", "indexer.ts", "// TODO: retry");
    const after = fp("generic/todo-marker", "indexer.ts", "// TODO: retry");
    expect(after).toBe(before);
  });

  it("ignores reindentation and collapsed whitespace runs", () => {
    const tight = fp("js/no-eval", "h", "eval(userInput)");
    const loose = fp("js/no-eval", "h", "\n\t  eval(userInput)   \n");
    expect(loose).toBe(tight);
  });

  it("ignores whitespace a formatter adds or removes around punctuation", () => {
    // The regression this guards: collapsing whitespace RUNS alone leaves
    // `"a" ;` distinct from `"a";`, so running Prettier over a repo would
    // invalidate every stored suppression in it.
    const original = fp("js/x", "s", 'const x = "a";');
    expect(fp("js/x", "s", 'const   x   =    "a" ;')).toBe(original);
    expect(fp("js/x", "s", 'const x="a";')).toBe(original);
  });

  it("ignores string literal contents", () => {
    const a = fp("js/sql-injection", "s", 'db.query("SELECT * FROM users" + n)');
    const b = fp("js/sql-injection", "s", 'db.query("SELECT * FROM accounts" + n)');
    expect(b).toBe(a);
  });

  it("ignores string quoting style", () => {
    const dq = fp("js/x", "s", 'f("v")');
    expect(fp("js/x", "s", "f('v')")).toBe(dq);
    expect(fp("js/x", "s", "f(`v`)")).toBe(dq);
  });

  it("ignores numeric literal values, including hex and exponent forms", () => {
    const base = fp("js/x", "s", "retry(3)");
    expect(fp("js/x", "s", "retry(9999)")).toBe(base);
    expect(fp("js/x", "s", "retry(0xFF)")).toBe(base);
    expect(fp("js/x", "s", "retry(3.14e2)")).toBe(base);
  });

  it("ignores leading and trailing whitespace in ruleId and scope", () => {
    const clean = fingerprint({ ruleId: "js/x", scope: "S.m", normalizedSnippet: "y" });
    const padded = fingerprint({ ruleId: "  js/x  ", scope: "\tS.m\n", normalizedSnippet: "y" });
    expect(padded).toBe(clean);
  });
});

describe("fingerprint: what MUST change it", () => {
  it("distinguishes different identifiers", () => {
    // The counterweight to every invariance above: over-normalising until
    // everything matches would make the fingerprint useless. Renaming the
    // variable IS a different finding.
    const a = fp("js/no-eval", "h", "eval(userInput)");
    const b = fp("js/no-eval", "h", "eval(adminInput)");
    expect(b).not.toBe(a);
  });

  it("does not collide `return x` with `returnx`", () => {
    // Proves the whitespace rule stopped short of deleting every space.
    expect(fp("r", "s", "return x")).not.toBe(fp("r", "s", "returnx"));
  });

  it("distinguishes different rules on identical code", () => {
    expect(fp("js/no-eval", "h", "eval(x)")).not.toBe(fp("js/dynamic-code", "h", "eval(x)"));
  });

  it("distinguishes the same code in different scopes", () => {
    // Two identical snippets in two functions are two findings, and must be
    // independently suppressible.
    expect(fp("js/x", "Alpha.run", "eval(x)")).not.toBe(fp("js/x", "Beta.run", "eval(x)"));
  });

  it("keeps distinct comment text distinct", () => {
    // Comments are deliberately not stripped: for the TODO/FIXME and
    // suppressed-checker rules the comment IS the evidence. Stripping would
    // collapse every TODO in a file into one fingerprint, so suppressing one
    // would suppress all of them.
    const retry = fp("generic/todo-marker", "f.ts", "// TODO: handle retry");
    const cache = fp("generic/todo-marker", "f.ts", "// TODO: invalidate cache");
    expect(cache).not.toBe(retry);
    expect(retry).not.toBe(fp("generic/todo-marker", "f.ts", ""));
  });

  it("cannot be confused by field boundaries", () => {
    // With a plain delimiter, ("a", "bc") and ("ab", "c") serialise
    // identically. Length-prefixing each field removes that class of collision
    // without forbidding any character inside a snippet.
    const left = fingerprint({ ruleId: "a", scope: "bc", normalizedSnippet: "" });
    const right = fingerprint({ ruleId: "ab", scope: "c", normalizedSnippet: "" });
    expect(left).not.toBe(right);
  });

  it("distinguishes a literal from an identifier in the same position", () => {
    // `f("x")` and `f(x)` are genuinely different code; eliding literals must
    // not blur them together.
    expect(fp("r", "s", 'f("x")')).not.toBe(fp("r", "s", "f(x)"));
  });
});

describe("fingerprint: output shape and pinned values", () => {
  it("is 32 lowercase hex characters", () => {
    expect(fp("js/no-eval", "h", "eval(x)")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("accepts empty inputs without throwing", () => {
    expect(fingerprint({ ruleId: "", scope: "", normalizedSnippet: "" })).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles non-ASCII source without throwing or truncating", () => {
    const out = fp("r", "Класс.метод", 'const 名前 = "値"; // ✅');
    expect(out).toMatch(/^[0-9a-f]{32}$/);
    expect(out).not.toBe(fp("r", "Класс.метод", 'const 名前 = "値"; // ❌'));
  });

  /**
   * Pinned outputs. These are the reason this file exists.
   *
   * If you changed the algorithm, these SHOULD fail — and the correct response
   * is a migration that rewrites stored fingerprints, not an update to these
   * numbers. Editing the expected values to make the suite pass silently
   * discards every user's suppressions and baselines.
   */
  it("matches known-good vectors (changing these requires a migration)", () => {
    expect(fp("js/sql-injection", "UserRepo.findByName", 'db.query("SELECT * FROM users WHERE name = " + name)'))
      .toBe("2be38bb7c28fe8f8c0d2b30442743163");
    expect(fp("js/no-eval", "handler", "eval(userInput)"))
      .toBe("4a0f6fcec97564c8119943c365885677");
    expect(fp("generic/todo-marker", "indexer.ts", "// TODO: handle the retry case"))
      .toBe("80208d3a6933260e7b0f247d3f0aa1b5");
    expect(fingerprint({ ruleId: "", scope: "", normalizedSnippet: "" }))
      .toBe("63cab8e921e413242a44bf4e8fdc999d");
  });
});

describe("normalizeSnippet", () => {
  it("elides string and number literals to distinct sentinels", () => {
    // Distinct sentinels, so `f("1")` and `f(1)` do not converge.
    expect(normalizeSnippet('f("1")')).not.toBe(normalizeSnippet("f(1)"));
  });

  it("elides a whole hex literal rather than splitting at the leading zero", () => {
    // `\b\d+` would match the `0` of `0xFF` and leave `xFF` behind as an
    // identifier, so hex has to be tried first.
    expect(normalizeSnippet("m(0xFF)")).toBe(normalizeSnippet("m(255)"));
    expect(normalizeSnippet("m(0xFF)")).not.toContain("x");
  });

  it("does not mistake an escaped quote for the end of a string", () => {
    expect(normalizeSnippet('f("a\\"b", c)')).toBe(normalizeSnippet('f("z", c)'));
  });

  it("preserves a JS private field, which comment-stripping would have eaten", () => {
    // A `#`-comment rule would destroy `this.#count`. Comments are not stripped
    // at all, so this is safe — asserted because it is easy to "improve" later.
    expect(normalizeSnippet("this.#count += 1")).toContain("#count");
  });

  it("is idempotent", () => {
    const once = normalizeSnippet('const  x =  "v" ;  ');
    expect(normalizeSnippet(once)).toBe(once);
  });
});
