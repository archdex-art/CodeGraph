import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/main";
import { runFix } from "../src/fix";

/**
 * `codegraph fix` — the command that makes `verified: full` reachable (SPIKES.md §2).
 *
 * Gate 3 runs the analysed repository's test suite, which needs an isolated container. Render
 * grants none, so the hosted demo can only ever report `partial`. These tests assert the CLI
 * reaches `full`, because that claim is the reason this app exists.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A repo with one auto-fixable finding per fixer class and a passing test suite. */
function fixture(opts: { testExits?: number } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-cli-test-"));
  trees.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src/app.js"),
    [
      "export function add(a, b) {",
      '  console.log("debug", a, b);',
      "  return a + b;",
      "}",
      "",
      "export function risky() {",
      "  try {",
      '    return JSON.parse("{}");',
      "  } catch (e) {}",
      "}",
      "",
      "// TODO: remove before release",
      'export const VERSION = "1.0.0";',
      "",
    ].join("\n")
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "node --test test.js" } })
  );
  writeFileSync(
    path.join(root, "test.js"),
    [
      'const assert = require("node:assert");',
      'const { test } = require("node:test");',
      `test("t", () => { assert.strictEqual(1, ${opts.testExits === 1 ? 2 : 1}); });`,
    ].join("\n")
  );
  return root;
}

describe("parseArgs", () => {
  it("defaults to the working directory and no verification", () => {
    const a = parseArgs(["fix"]);
    expect(a.command).toBe("fix");
    expect(a.path).toBe(".");
    expect(a.verify).toBe(false);
  });

  it("rejects a flag missing its value instead of binding undefined", () => {
    // The real bug this prevents: `--rule` with no value bound undefined and then ran EVERY
    // fixer — the opposite of what was asked. Found by the compiler once apps/cli was
    // actually typechecked.
    expect(() => parseArgs(["fix", "--rule"])).toThrow(/--rule expects a value/);
    expect(() => parseArgs(["fix", "--file"])).toThrow(/--file expects a value/);
  });

  it("rejects a flag whose value is another flag", () => {
    expect(() => parseArgs(["fix", "--rule", "--verify"])).toThrow(/expects a value/);
  });

  it("rejects a non-numeric or non-positive timeout rather than coercing it", () => {
    // Silently falling back to the default is how someone thinks they capped a run that is
    // actually running for five minutes.
    expect(() => parseArgs(["fix", "--test-timeout", "abc"])).toThrow(/positive number/);
    expect(() => parseArgs(["fix", "--test-timeout", "0"])).toThrow(/positive number/);
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["fix", "--wat"])).toThrow(/Unknown option/);
  });
});

describe("runFix", () => {
  it("reaches `full` when the repository's own suite runs and passes", async () => {
    // THE point of the CLI. Render cannot produce this value at all (SPIKES §2).
    const out = await runFix({ repo: fixture(), verify: true, json: false, testTimeout: 60 });
    expect(out.record?.level).toBe("full");
    expect(out.record?.gates.find((g) => g.gate === "tests")?.status).toBe("passed");
  });

  it("reaches only `partial` without --verify, and says which lever to pull", async () => {
    const out = await runFix({ repo: fixture(), verify: false, json: false, testTimeout: 60 });
    expect(out.record?.level).toBe("partial");
    const tests = out.record?.gates.find((g) => g.gate === "tests");
    expect(tests?.status).toBe("skipped");
    // Must NOT name CG_ALLOW_TEST_VERIFICATION — that variable does not exist here, and a skip
    // reason pointing at the wrong lever misdirects.
    expect(tests?.reason).toMatch(/--verify/);
    expect(tests?.reason).not.toMatch(/CG_ALLOW_TEST_VERIFICATION/);
  });

  it("fails the tests gate when the suite fails", async () => {
    const out = await runFix({
      repo: fixture({ testExits: 1 }),
      verify: true,
      json: false,
      testTimeout: 60,
    });
    expect(out.record?.gates.find((g) => g.gate === "tests")?.status).toBe("failed");
  });

  it("re-parses the changed files rather than reporting a vacuous pass", async () => {
    // syntaxGate derives its file list from `candidate.edits`. A hand-built `edits: []` returns
    // "passed — no files edited" WITHOUT PARSING ANYTHING, which is a gate reporting success
    // for doing nothing. `candidateFor` exists to stop that.
    const out = await runFix({ repo: fixture(), verify: false, json: false, testTimeout: 60 });
    const syntax = out.record?.gates.find((g) => g.gate === "syntax");
    expect(syntax?.status).toBe("passed");
    expect(syntax?.reason).toMatch(/re-parsed/);
    expect(syntax?.reason).not.toMatch(/no files edited/);
  });

  it("never modifies the source tree", async () => {
    // The CLI's central promise. Everything happens in a temp copy.
    const root = fixture();
    const before = readFileSync(path.join(root, "src/app.js"), "utf8");
    await runFix({ repo: root, verify: false, json: false, testTimeout: 60 });
    expect(readFileSync(path.join(root, "src/app.js"), "utf8")).toBe(before);
  });

  it("scopes to one rule when asked", async () => {
    const out = await runFix({
      repo: fixture(),
      verify: false,
      json: false,
      testTimeout: 60,
      rule: "legacy/todo-fixme-marker",
    });
    expect(out.editCount).toBe(1);
    expect(out.diff).toMatch(/TODO/);
    // The debug line is a different rule and must survive.
    expect(out.diff).not.toMatch(/console\.log/);
  });

  it("refuses a rule no provider handles instead of running everything", async () => {
    await expect(
      runFix({ repo: fixture(), verify: false, json: false, testTimeout: 60, rule: "nope/x" })
    ).rejects.toThrow(/No fixer handles rule/);
  });
});

describe("the emitted diff", () => {
  /**
   * `git apply` IS the specification. The first version of this diff looked correct, rendered
   * correctly, and was rejected — twice, for two separate reasons (new-side hunk offsets not
   * accounting for earlier deletions, and a phantom trailing "" line from `split("\n")` making
   * the hunk claim one line too many). Neither was visible by reading the output.
   */
  it("applies cleanly with git apply, and the suite still passes afterwards", async () => {
    const root = fixture();
    const out = await runFix({ repo: root, verify: false, json: false, testTimeout: 60 });

    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git(["init", "-q", "."]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);

    const patch = path.join(root, "fix.patch");
    writeFileSync(patch, `${out.diff}\n`);

    // Throws on rejection, which is the assertion.
    expect(() => git(["apply", "--check", patch])).not.toThrow();
    git(["apply", patch]);

    // The patched tree must still be a working project, not merely a parsing one.
    expect(() =>
      execFileSync("npm", ["test", "--silent"], { cwd: root, stdio: "pipe" })
    ).not.toThrow();

    const after = readFileSync(path.join(root, "src/app.js"), "utf8");
    expect(after).not.toMatch(/console\.log/);
    expect(after).not.toMatch(/TODO/);
  });

  it("numbers the new side of each hunk correctly", async () => {
    // `git apply` searches by context, so it TOLERATES wrong hunk headers — which is why a
    // mutation removing this offset still passed the apply test above. The numbers are part of
    // the unified-diff contract regardless, and a stricter consumer (`patch`, a programmatic
    // parser, a review UI) reads them. Asserted directly because the forgiving consumer cannot.
    const out = await runFix({ repo: fixture(), verify: false, json: false, testTimeout: 60 });
    const headers = [...out.diff.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/gm)].map((m) => ({
      oldStart: Number(m[1]),
      oldCount: Number(m[2]),
      newStart: Number(m[3]),
      newCount: Number(m[4]),
    }));
    expect(headers.length).toBeGreaterThanOrEqual(2);

    // The first hunk starts at the same line on both sides; every later hunk is shifted by the
    // net lines removed before it.
    let delta = 0;
    for (const h of headers) {
      expect(h.newStart).toBe(h.oldStart - delta);
      delta += h.oldCount - h.newCount;
    }
    // The fixture deletes lines, so the shift must actually be exercised — otherwise this test
    // would pass on a diff where every delta is zero and prove nothing.
    expect(delta).toBeGreaterThan(0);
  });

  it("produces a multi-hunk diff for edits far apart in one file", async () => {
    // Single-hunk diffs hid the offset bug entirely — it only appears from the second hunk on.
    const out = await runFix({ repo: fixture(), verify: false, json: false, testTimeout: 60 });
    expect(out.diff.match(/^@@ /gm)?.length).toBeGreaterThanOrEqual(2);
  });
});
