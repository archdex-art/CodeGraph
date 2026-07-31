import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * Rules fire only in the syntactic context where they can be true (PLAN.md P5, item 1).
 *
 * Measured across every rule match before this existed: **35% on express, 64% on this
 * repository** landed somewhere the rule cannot hold. On express the suppressed 21 were, every
 * one, verified noise - `eval(` and `innerHTML` inside an XSS *test fixture string* in
 * `test/res.redirect.js`, and 16 `http://localhost:3000` URLs inside `// example:` comments.
 *
 * The gate is per-rule, not "strip comments and strings", because the right context differs by
 * rule - which is what the last two tests here defend.
 */
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function findings(file: string, text: string): Promise<string[]> {
  dir = mkdtempSync(path.join(tmpdir(), "cg-ctx-"));
  writeFileSync(path.join(dir, file), text);
  const r = await indexRepo(dir);
  return r.issues.map((i) => i.title);
}

describe("rule context gating", () => {
  it("still fires on real code — the gate must not silence the rule", async () => {
    // Guard against the failure mode that would make every other test here pass trivially.
    expect(await findings("a.ts", "export function go() { return eval('1+1'); }\n")).toContain(
      "Use of eval()",
    );
  });

  it("ignores a match inside a comment", async () => {
    expect(await findings("b.ts", "// never call eval(x) here\nexport const z = 1;\n")).not.toContain(
      "Use of eval()",
    );
  });

  it("ignores a match inside a string literal", async () => {
    // express's actual false positive: an XSS payload held as test data.
    const src = "export const xss = 'javascript:eval(document.body.innerHTML=1)';\n";
    const got = await findings("c.ts", src);
    expect(got).not.toContain("Use of eval()");
    expect(got).not.toContain("Raw HTML injection sink");
  });

  it("keeps a TODO marker in a comment but not in a string", async () => {
    // Blanket comment-stripping would delete this rule's only true positives.
    expect(await findings("d.ts", "// TODO: fix this\nexport const a = 1;\n")).toContain(
      "TODO/FIXME marker",
    );
    expect(await findings("e.ts", 'export const msg = "TODO list feature";\n')).not.toContain(
      "TODO/FIXME marker",
    );
  });

  it("keeps a hardcoded localhost URL in a string but not in a comment", async () => {
    // Inverse of the TODO case: this one is only ever true INSIDE a string.
    expect(await findings("f.ts", 'export const u = "http://localhost:3000/api";\n')).toContain(
      "Hardcoded local URL",
    );
    expect(await findings("g.ts", "// example: http://localhost:3000/api\nexport const a = 1;\n")).not.toContain(
      "Hardcoded local URL",
    );
  });

  it("leaves languages the scanner does not cover exactly as they were", async () => {
    /**
     * Python gets no spans, so every position is `code` and nothing is suppressed. A
     * hand-rolled Python lexer would risk false NEGATIVES, which is the worse failure.
     *
     * The sample deliberately contains a STRING and an apostrophe. A first version used
     * `# TODO: tidy up` alone - no quotes - so the TS scanner produced no spans whether or
     * not the guard existed, `spans.length` was 0 either way, and the assertion could not
     * distinguish them. Mutation testing caught that: deleting the guard left it green.
     * With a quote present the scanner DOES emit spans, so the guard is load-bearing here.
     */
    const py = '# TODO: don\'t tidy up\nname = "world"\nprint(name)\n';
    expect(await findings("h.py", py)).toContain("TODO/FIXME marker");
  });

  it("maps a match on a later line to the right offset", async () => {
    /**
     * Line-start offsets must account for the newline `split` removed. Without the `+ 1` the
     * error accumulates one character per line, so a match far enough down the file resolves
     * against the wrong span. Every earlier case here sat on line 1, where the offset is 0
     * whether or not the arithmetic is right - so none of them could see it.
     */
    const src =
      // 20 lines, not 12: each line drifts the offset by one, and at 12 the drifted position
      // lands exactly ON the string's opening quote - still "inside" - so the bug hid.
      "export const a = 1;\n".repeat(20) +
      "export const payload = 'javascript:eval(1)';\n";
    expect(await findings("i.ts", src)).not.toContain("Use of eval()");
  });
});
