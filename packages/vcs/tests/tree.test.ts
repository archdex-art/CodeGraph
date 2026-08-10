import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitTreeFiles, hasWorkingTree, materialisePaths, materialiseWorkingTree, readBlobs } from "../src/index";

/**
 * Reading a repository out of git instead of off disk.
 *
 * The property that matters is EQUIVALENCE: what git reports must be exactly what a
 * filesystem walk of the same checkout would find, or the coverage numbers and the Health
 * Score quietly change meaning depending on how the repository was acquired. Every assertion
 * below is either that equivalence or one of the encoding traps that breaks it.
 */

const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-tree-"));
  dirs.push(dir);
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gitTreeFiles", () => {
  it("lists every tracked file with the size git already knows", () => {
    const dir = repo({ "a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    const entries = gitTreeFiles(dir)!;
    expect(entries.map((e) => e.path).sort()).toEqual(["a.ts", "src/b.ts"]);
    // The size arrives BEFORE any content is read, which is what makes a size cap free.
    for (const e of entries) {
      expect(e.size).toBe(readFileSync(path.join(dir, e.path)).length);
      expect(e.oid).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("omits what .gitignore excludes, without a second git call", () => {
    // The walker needed a separate `git ls-files` pass for exactly this. Tracked-only is free.
    const dir = repo({ ".gitignore": "secret.txt\n", "kept.ts": "export const k = 1;\n" });
    writeFileSync(path.join(dir, "secret.txt"), "nope\n");
    expect(gitTreeFiles(dir)!.map((e) => e.path)).not.toContain("secret.txt");
  });

  it("survives a path containing a newline", () => {
    /*
     * The reason the listing is read `-z`. Without it git C-quotes the name and a line-based
     * parser sees two files, one of which does not exist - silently, and only on the
     * repositories perverse enough to contain one.
     */
    const dir = repo({ "plain.ts": "export const p = 1;\n" });
    const weird = "we\nird.ts";
    writeFileSync(path.join(dir, weird), "export const w = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "weird");
    const paths = gitTreeFiles(dir)!.map((e) => e.path);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(weird);
  });

  it("returns null for a directory that is not a git checkout", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cg-plain-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    // Null, not an empty list: "cannot answer" and "answered, nothing tracked" are different,
    // and only the first should make the caller fall back to walking the filesystem.
    expect(gitTreeFiles(dir)).toBeNull();
  });

  it("does not report a submodule as a file", () => {
    /*
     * `ls-tree -r` emits gitlinks alongside blobs, as `160000 commit <sha> - <path>`. The size
     * column is `-`, so anything that took the row at face value would enqueue a nonexistent
     * blob and count a directory as a source file in the coverage numbers.
     */
    const dir = repo({ "a.ts": "export const a = 1;\n" });
    const sha = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/sub`);
    git(dir, "commit", "--quiet", "-m", "gitlink");
    const paths = gitTreeFiles(dir)!.map((e) => e.path);
    expect(paths).toEqual(["a.ts"]);
  });
});

describe("readBlobs", () => {
  it("reads every requested blob in one pass, byte for byte", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`f${i}.ts`] = `export const v${i} = ${i};\n`;
    const dir = repo(files);
    const entries = gitTreeFiles(dir)!;
    const blobs = readBlobs(dir, entries.map((e) => e.oid));
    expect(blobs.size).toBe(entries.length);
    for (const e of entries) {
      expect(blobs.get(e.oid)).toBe(readFileSync(path.join(dir, e.path), "utf8"));
    }
  });

  it("does not desync when a file's own text looks like a batch header", () => {
    /*
     * `cat-file --batch` is length-prefixed, and this proves the parser must honour the
     * length rather than scan for the next newline.
     *
     * The decoy line is an EXACTLY well-formed record header - 40 hex, `blob`, a size - on its
     * own line inside a source file. A near-miss does not test anything: the type check makes
     * the parser resync on any line that is not header-shaped, so an approximate decoy passes
     * whichever strategy is used (confirmed by mutation testing). Only a line the parser would
     * genuinely accept can desync it, and a file must sort AFTER the decoy for the damage to
     * be observable, because content is stored before the pointer advances.
     */
    const decoy = `const s = 1;\n${"a".repeat(40).replace(/a/g, "0")} blob 99999\nconst t = 2;\n`;
    const dir = repo({ "decoy.ts": decoy, "after.ts": "export const after = 1;\n", "zz.ts": "export const zz = 1;\n" });
    const entries = gitTreeFiles(dir)!;
    const blobs = readBlobs(dir, entries.map((e) => e.oid));
    const byPath = new Map(entries.map((e) => [e.path, blobs.get(e.oid)]));
    expect(byPath.get("decoy.ts")).toBe(decoy);
    expect(byPath.get("after.ts")).toBe("export const after = 1;\n");
    expect(byPath.get("zz.ts")).toBe("export const zz = 1;\n");
  });

  it("skips an object it cannot find rather than failing the whole read", () => {
    const dir = repo({ "a.ts": "export const a = 1;\n" });
    const real = gitTreeFiles(dir)![0]!;
    const blobs = readBlobs(dir, ["0".repeat(40), real.oid]);
    expect(blobs.has(real.oid)).toBe(true);
    expect(blobs.size).toBe(1);
  });

  it("ignores an object that exists but is not a blob", () => {
    /*
     * A tree oid resolves, so git answers `<oid> tree <size>` rather than `missing`. Treating
     * that as file content would hand a directory listing to the parser as if it were source.
     */
    const dir = repo({ "src/a.ts": "export const a = 1;\n" });
    const treeOid = git(dir, "rev-parse", "HEAD^{tree}").trim();
    const real = gitTreeFiles(dir)![0]!;
    const blobs = readBlobs(dir, [treeOid, real.oid]);
    expect(blobs.has(treeOid)).toBe(false);
    expect(blobs.get(real.oid)).toBe("export const a = 1;\n");
  });

  it("returns nothing for an empty request without spawning git", () => {
    expect(readBlobs(repo({ "a.ts": "x\n" }), []).size).toBe(0);
  });
});

describe("the working tree, materialised only when something needs it", () => {
  it("reports a --no-checkout clone as having no working tree, and can fill it in", () => {
    const origin = repo({ "a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "cg-nc-")), "repo");
    dirs.push(path.dirname(dest));
    execFileSync("git", ["clone", "--quiet", "--no-checkout", origin, dest], { stdio: ["ignore", "pipe", "pipe"] });

    expect(hasWorkingTree(dest)).toBe(false);
    // Yet the content is fully readable, which is the whole point: analysis needs no checkout.
    const entries = gitTreeFiles(dest)!;
    expect(entries.map((e) => e.path).sort()).toEqual(["a.ts", "src/b.ts"]);
    expect(readBlobs(dest, entries.map((e) => e.oid)).size).toBe(2);
    expect(existsSync(path.join(dest, "a.ts"))).toBe(false);

    materialiseWorkingTree(dest);
    expect(hasWorkingTree(dest)).toBe(true);
    expect(readFileSync(path.join(dest, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("checks out only the manifests the dependency analysers read off disk", () => {
    const origin = repo({ "package.json": "{}\n", "src/big.ts": "export const b = 1;\n" });
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "cg-man-")), "repo");
    dirs.push(path.dirname(dest));
    execFileSync("git", ["clone", "--quiet", "--no-checkout", origin, dest], { stdio: ["ignore", "pipe", "pipe"] });

    materialisePaths(dest, ["package.json", "requirements.txt"]);
    expect(existsSync(path.join(dest, "package.json"))).toBe(true);
    // The pathspec that matches nothing is not an error, and the rest stays unwritten.
    expect(existsSync(path.join(dest, "src/big.ts"))).toBe(false);
  });

  it("treats an ordinary directory as already being its own working tree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cg-plain2-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    expect(hasWorkingTree(dir)).toBe(true);
  });
});
