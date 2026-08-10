import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";
import type { IndexResult } from "@codegraph/analysis-model";

/**
 * Indexing a repository that has no working tree.
 *
 * Repositories are cloned `--no-checkout` because analysis reads its files out of git:
 * measured on `microsoft/TypeScript`, the objects are 41 MB and the checkout is 655 MB of
 * files the walk reads once and discards. The tree is materialised later, by
 * `requireWorkspace`, only when a route wants real paths.
 *
 * THE PROPERTY THAT MATTERS IS EQUIVALENCE. A Health Score that moves depending on how the
 * repository was ACQUIRED is not a measurement of the repository. The first run of this
 * without the shared skip rules reported `sindresorhus/slugify` as 8 files and 1,094 LOC from
 * git against 6 and 1,068 from disk, because `ls-tree` lists dotfiles and the contents of
 * `dist/` and `vendor/` while the walk skips both. So the assertions below compare the two
 * sources against each other rather than against hardcoded numbers - a fixture's expected
 * counts can be edited to match a bug, but the two sources agreeing cannot.
 */

const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A committed repository containing every category the skip rules care about. */
function originRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-gs-origin-"));
  dirs.push(dir);
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");

  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", dependencies: { leftpad: "^1.0.0" } }),
    "src/a.ts": "export function a() { return 1; }\n",
    "src/b.ts": "import { a } from './a';\nexport function b() { return a(); }\n",
    "readme.md": "# fixture\n",
    // Tracked, but the walk never descends into either of these.
    "dist/bundle.js": "console.log('built');\n",
    "vendor/lib.js": "module.exports = 1;\n",
    // Tracked dotfiles. `ls-tree` lists them; the walk skips anything starting with a dot.
    ".editorconfig": "root = true\n",
    ".github/workflows/ci.yml": "name: ci\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "--quiet", "-m", "fixture");
  return dir;
}

/**
 * The same commit, cloned without a working tree — exactly as `cloneRepo` leaves it.
 *
 * Including the manifests, because `cloneRepo` materialises those and only those. Leaving
 * them out would compare a production git index against a NON-production disk index and call
 * the difference a bug in the source: `advisories.ts` reads `package.json` off disk, so
 * without it the dependency findings vanish and the score moves by seven points.
 */
function bareish(origin: string, opts?: { manifests?: boolean }): string {
  const parent = mkdtempSync(path.join(tmpdir(), "cg-gs-clone-"));
  dirs.push(parent);
  const dest = path.join(parent, "repo");
  execFileSync("git", ["clone", "--quiet", "--no-checkout", origin, dest], { stdio: ["ignore", "pipe", "pipe"] });
  if (opts?.manifests !== false) {
    execFileSync("git", ["checkout", "HEAD", "--", "package.json"], { cwd: dest, stdio: ["ignore", "pipe", "pipe"] });
  }
  return dest;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("indexing from git objects instead of a working tree", () => {
  it("produces the same score, LOC and file set as walking the checkout", async () => {
    const origin = originRepo();
    const fromDisk = await indexRepo(origin);
    const fromGit = await indexRepo(bareish(origin));

    expect(fromGit.score).toBe(fromDisk.score);
    expect(fromGit.loc).toBe(fromDisk.loc);
    expect(fromGit.coverage!.filesAnalysed).toBe(fromDisk.coverage!.filesAnalysed);
    expect(fromGit.coverage!.filesSeen).toBe(fromDisk.coverage!.filesSeen);

    const names = (r: IndexResult) =>
      r.viz.nodes.filter((n) => n.kind === "file").map((n) => n.id).sort();
    expect(names(fromGit)).toEqual(names(fromDisk));
  });

  it("applies the walk's skip rules to the tree listing", async () => {
    // The specific divergence that existed: git lists these, the walk never sees them, and
    // counting them inflated LOC and turned `dist/` output into analysed source.
    const fromGit = await indexRepo(bareish(originRepo()));
    const files = fromGit.viz.nodes.filter((n) => n.kind === "file").map((n) => n.id);
    expect(files).toContain("src/a.ts");
    for (const skipped of ["dist/bundle.js", "vendor/lib.js", ".editorconfig", ".github/workflows/ci.yml"]) {
      expect(files, skipped).not.toContain(skipped);
    }
  });

  it("reads the manifests the dependency analysers take off disk, and is blind without them", async () => {
    /*
     * `advisories.ts` finds `package.json` with `readdirSync` and reads it with
     * `readFileSync`, so a tree with no checkout looks like a project declaring no
     * dependencies - a wrong answer, and a silent one. That is why `cloneRepo` materialises
     * the manifests and nothing else, and this asserts BOTH directions: with them the
     * dependency is found, without them it is not. The negative half is the one that would
     * catch someone "simplifying" the materialisation away.
     */
    const origin = originRepo();
    expect((await indexRepo(bareish(origin))).dependencies).toContain("leftpad");
    expect((await indexRepo(bareish(origin, { manifests: false }))).dependencies).not.toContain("leftpad");
  });

  it("stops at the file cap and counts only what it considered", async () => {
    /*
     * `filesSeen` must mean "examined", not "exists in the tree". The walk stops descending at
     * the cap and reports the prefix it reached; if the tree source counted the whole listing
     * instead, `filesKept + skippedTooLarge + skippedIgnored === filesSeen` would fail the
     * moment a repository was large enough to truncate - which is exactly the repository
     * nobody tests by hand.
     */
    const KEY = "CG_MAX_FILES";
    const original = process.env[KEY];
    process.env[KEY] = "2";
    try {
      const c = (await indexRepo(bareish(originRepo()))).coverage!;
      expect(c.capHit).toBe(true);
      expect(c.filesKept).toBe(2);
      expect(c.filesSeen).toBe(2);
      expect(c.filesKept + c.skippedTooLarge + (c.skippedIgnored ?? 0)).toBe(c.filesSeen);
    } finally {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    }
  });

  it("holds the coverage accounting invariant on a tree-sourced index", async () => {
    // The same invariant `coverage.test.ts` defends for the walk. Every file SEEN lands in
    // exactly one bucket, whichever source enumerated it.
    const c = (await indexRepo(bareish(originRepo()))).coverage!;
    expect(c.filesKept + c.skippedTooLarge + (c.skippedIgnored ?? 0)).toBe(c.filesSeen);
    expect(c.filesAnalysed + c.skippedNoLanguage).toBe(c.filesKept);
  });
});
