import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * A marker must BE one, not mention one.
 *
 * Both rules scored 0 in the precision audit (`docs/design/PRECISION_PROTOCOL.md`) —
 * TODO 0/4, Suppressed checker 0/1 — and together they were 11 of the 14 false positives.
 * Restricting them to comments was necessary and not sufficient: a comment discussing markers
 * is still a comment.
 *
 * Two signals fix it, and both came from reading the actual false positives:
 *   1. a real marker FOLLOWS the comment opener; a mention sits mid-sentence;
 *   2. a marker inside backticks is a quoted example, not a marker left behind.
 */
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function titles(src: string, name = "a.ts"): Promise<string[]> {
  dir = mkdtempSync(path.join(tmpdir(), "cg-mark-"));
  writeFileSync(path.join(dir, name), src);
  return (await indexRepo(dir)).issues.map((i) => i.title);
}

describe("marker rules", () => {
  it("reports a real TODO after each comment opener form", async () => {
    // Guards against a fix that silences the rule instead of narrowing it.
    for (const src of [
      "// TODO: fix this\nexport const a = 1;\n",
      "export const a = 1; // FIXME: later\n",
      "/**\n * TODO: jsdoc form\n */\nexport const a = 1;\n",
      "/* HACK: workaround */\nexport const a = 1;\n",
    ]) {
      expect(await titles(src), src).toContain("TODO/FIXME marker");
    }
  });

  it("ignores prose that merely mentions a marker", async () => {
    // Verbatim shapes from the audit's four false positives.
    for (const src of [
      "// Stripping it would reduce every TODO in a file to the same thing\nexport const a = 1;\n",
      "// 1. Base maintainability issues (e.g. God files, TODO markers)\nexport const a = 1;\n",
      "// Inverse of the TODO case: this one is only true INSIDE a string.\nexport const a = 1;\n",
    ]) {
      expect(await titles(src), src).not.toContain("TODO/FIXME marker");
    }
  });

  it("ignores a marker quoted as an example", async () => {
    const src = "// like `const x = 1; // TODO: later`, which still matches\nexport const a = 1;\n";
    expect(await titles(src)).not.toContain("TODO/FIXME marker");
  });

  it("still reports a real marker when an EARLIER one on the line is quoted", async () => {
    /**
     * Every match is checked, not just the first. The fixture must put the quoted marker
     * FIRST: with a real marker first, checking only match #1 also passes and the mutation
     * that stops scanning survives — which is exactly what happened before this was rewritten.
     */
    const src = "// like `// TODO: quoted` and then // TODO: really fix\nexport const a = 1;\n";
    expect(await titles(src)).toContain("TODO/FIXME marker");
  });

  it("reports a real suppression directive", async () => {
    const src = "// eslint-disable-next-line no-console\nexport const a = 1;\n";
    expect(await titles(src)).toContain("Suppressed checker");
  });

  it("ignores a doc comment explaining a suppression", async () => {
    // The audit's single Suppressed false positive: nothing was suppressed.
    const src = "// a marker belongs in a comment; `@ts-ignore` can only ever be one\nexport const a = 1;\n";
    expect(await titles(src)).not.toContain("Suppressed checker");
  });

  it("ignores a suppression named in prose WITHOUT backticks", async () => {
    /**
     * Separates the two signals. The backticked case above is caught by the quoted-example
     * guard alone, so it passes even with the opener anchor reverted — mutation testing showed
     * that. Unquoted prose is caught only by the anchor.
     */
    const src = "// the eslint-disable directive is explained in the docs\nexport const a = 1;\n";
    expect(await titles(src)).not.toContain("Suppressed checker");
  });
});
