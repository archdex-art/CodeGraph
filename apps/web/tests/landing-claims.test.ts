import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The landing page publishes numbers about this repository. This asserts they are true.
 *
 * WHY THIS FILE EXISTS. `apps/web/tests/readme-claims.test.ts` has guarded the README's counts
 * since four of them went stale. The landing page had no such guard and drifted further, on the
 * surface more people read, under a footer that says:
 *
 *   "Every number on this page was measured on a real repository, and the commands that
 *    measure it are in the repo."
 *
 * It was publishing `957 tests` across `75 files` against a real 1,844 across 107, and
 * "2.1s to index 327 files" from a profile taken on a 303-file tree before six of the eleven
 * pipeline stages existed. Two further claims - 87% detection precision, 313.9 MiB peak memory -
 * had no command behind them at all and were removed rather than corrected.
 *
 * WHAT IS AND IS NOT ASSERTED HERE. Counts of things in the working tree are checkable and are
 * checked. The wall clock is NOT: a timing measures the machine as much as the code, so it is
 * published with a date, the same way the README publishes its case count, and `npm run
 * selfindex` reprints it. Asserting a duration here would produce a test that fails on a slow
 * CI runner and teaches everyone to ignore it.
 */

/* `npm run test` runs every project from the repository root, so `cwd` is the root - the same
   assumption `readme-claims.test.ts` makes when it reads `README.md`. */
const root = process.cwd();
const PAGE = readFileSync(path.join(root, "apps/web/src/app/page.tsx"), "utf8");

/** The `PROOF` entry whose label contains `needle`, as `{ value, note }`. */
function proof(needle: string): { value: number; note: string } {
  const block = PAGE.slice(PAGE.indexOf("const PROOF = ["), PAGE.indexOf("];", PAGE.indexOf("const PROOF = [")));
  const line = block.split("\n").find((l) => l.includes(`label: "`) && l.includes(needle));
  if (!line) throw new Error(`No PROOF entry labelled with "${needle}". Landing copy changed; update this test deliberately.`);
  return {
    value: Number(/value:\s*([\d.]+)/.exec(line)?.[1]),
    note: /note:\s*"([^"]*)"/.exec(line)?.[1] ?? "",
  };
}

/** Every `*.test.ts` under the workspaces, counted the way `readme-claims` counts them. */
function countTestFiles(dirs: readonly string[]): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".test.ts")) n++;
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return n;
}

/** `.ts`/`.tsx` under the workspaces, which is what the caption and the PROOF strip name. */
function countTypeScriptFiles(): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "data" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) n++;
    }
  };
  for (const d of ["apps", "packages", "scripts"]) walk(path.join(root, d));
  return n;
}

describe("the landing page's published figures", () => {
  it("claims the number of test files that exist", () => {
    const claimed = Number(/(\d+) files, every gate in CI/.exec(proof("tests, all green").note)?.[1]);
    const actual = countTestFiles(["apps/cli/tests", "apps/web/tests", "apps/worker/tests", "packages"]);
    expect(claimed).toBe(actual);
  });

  it("claims a test count in the same order as the suite that exists", () => {
    /*
     * Not an exact equality: the case count moves with every commit, and a test that fails on
     * every added `it()` would be deleted within a week. What it defends is the failure that
     * actually happened - a figure left behind across hundreds of tests. `readme-claims`
     * carries the same figure as prose and calls it point-in-time for the same reason.
     */
    const claimed = proof("tests, all green").value;
    const files = countTestFiles(["apps/cli/tests", "apps/web/tests", "apps/worker/tests", "packages"]);
    expect(claimed).toBeGreaterThan(files * 5);
    expect(claimed).toBeLessThan(files * 40);
  });

  it("claims the number of TypeScript files the caption and the strip both name", () => {
    const actual = countTypeScriptFiles();
    expect(proof("TypeScript files").value).toBe(actual);
    // The bar chart's caption names the same figure a few hundred lines further down, and the
    // two drifted apart once already.
    const caption = Number(/repository&apos;s (\d+) TypeScript files/.exec(PAGE)?.[1]);
    expect(caption).toBe(actual);
  });

  it("publishes the timing with the date it was measured, rather than as a standing fact", () => {
    // The one figure this file refuses to assert. It must say WHEN instead.
    expect(proof("to index this repo, cold").note).toMatch(/measured \d{4}-\d{2}-\d{2}/);
  });

  it("no longer publishes a figure nothing in the repository can re-derive", () => {
    /*
     * "87% detection precision on held-out repos, never tuned against" named a corpus and a
     * protocol that do not exist here, and "313.9 MiB peak memory" disagreed with the only
     * measurement anyone can take (`/usr/bin/time -l npm run selfindex`: 943 MiB). Both were
     * removed. A negative assertion because the sentences were plausible, which is how they
     * survived every reading of this page.
     */
    expect(PAGE).not.toMatch(/detection precision/);
    expect(PAGE).not.toMatch(/peak memory/);
  });

  it("keeps the footer's promise checkable by naming the command", () => {
    // The footer says the commands are in the repo. This is that command.
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts.selfindex).toBeTruthy();
  });
});
