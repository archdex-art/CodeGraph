import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneRepo, refreshWorkspace } from "../src/index";

/**
 * Re-indexing a git repository whose workspace directory already exists.
 *
 * THE BUG THIS EXISTS TO STOP COMING BACK
 *
 * A persistent workspace is named by REPO ID. While every index minted a fresh id, `git clone`
 * always had an empty directory to land in. Once repositories gained a stable identity - so
 * re-indexing UPDATES a row instead of inserting a duplicate - the id stopped changing, and
 * every re-index of a git repo died on git's
 *
 *     fatal: destination path '...' already exists and is not an empty directory
 *
 * which reached the user as "Indexing did not complete. Retry, and if it keeps failing check
 * the source is a public git URL." - unhelpful, and about the one action the product tells them
 * to take. Two behaviours had to be right at once and both are pinned here: the second index
 * SUCCEEDS, and it does not destroy the tree, because the built-in editor commits from it.
 *
 * WHY MOST OF THIS TESTS `refreshWorkspace` RATHER THAN `cloneRepo`
 *
 * `cloneRepo` rejects anything that is not an `https?://` URL, which is an SSRF control and is
 * not being weakened to make a test convenient. `refreshWorkspace` is the unit that decides
 * reuse-or-replace, and it takes a plain remote, so a filesystem origin exercises the real git
 * behaviour with no network. The one `cloneRepo` case below stays offline by giving the
 * workspace an `https` origin that is never contacted.
 */

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A real repository on disk with one commit, usable as a clone source. */
function originRepo(): string {
  const dir = tempDir("cg-origin-");
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

/** A workspace cloned from `origin`, as the indexer would have left it. */
function workspaceFrom(origin: string): string {
  const dest = path.join(tempDir("cg-ws-"), "repo");
  execFileSync("git", ["clone", "--quiet", origin, dest], { stdio: ["ignore", "pipe", "pipe"] });
  git(dest, "config", "user.email", "t@example.com");
  git(dest, "config", "user.name", "T");
  return dest;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("refreshWorkspace: reuse or replace", () => {
  it("adopts a workspace already cloned from the same remote", async () => {
    const origin = originRepo();
    await expect(refreshWorkspace(workspaceFrom(origin), origin)).resolves.toBe(true);
  });

  it("fast-forwards a clean workspace to new upstream commits", async () => {
    // The reason re-indexing a git repository exists at all: pick up what landed since.
    const origin = originRepo();
    const dest = workspaceFrom(origin);
    writeFileSync(path.join(origin, "README.md"), "one\ntwo\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "second");

    await refreshWorkspace(dest, origin);
    expect(readFileSync(path.join(dest, "README.md"), "utf8")).toBe("one\ntwo\n");
  });

  it("keeps uncommitted work, because the editor commits from this tree", async () => {
    const origin = originRepo();
    const dest = workspaceFrom(origin);
    writeFileSync(path.join(dest, "README.md"), "one\nedited in the editor\n");
    writeFileSync(path.join(dest, "scratch.txt"), "untracked\n");

    // Upstream moves too, so the fast-forward is genuinely attempted and genuinely refused.
    writeFileSync(path.join(origin, "README.md"), "one\ntwo\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "second");

    await expect(refreshWorkspace(dest, origin)).resolves.toBe(true);
    expect(readFileSync(path.join(dest, "README.md"), "utf8")).toContain("edited in the editor");
    expect(existsSync(path.join(dest, "scratch.txt"))).toBe(true);
  });

  it("keeps a local commit the user has not pushed", async () => {
    const origin = originRepo();
    const dest = workspaceFrom(origin);
    writeFileSync(path.join(dest, "mine.txt"), "local work\n");
    git(dest, "add", "-A");
    git(dest, "commit", "--quiet", "-m", "local only");
    const head = git(dest, "rev-parse", "HEAD").trim();

    writeFileSync(path.join(origin, "README.md"), "one\ntwo\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "second");

    await expect(refreshWorkspace(dest, origin)).resolves.toBe(true);
    // Diverged, so the fast-forward is refused and the commit stands.
    expect(git(dest, "rev-parse", "HEAD").trim()).toBe(head);
    expect(existsSync(path.join(dest, "mine.txt"))).toBe(true);
  });

  it("refuses a directory that is not a git repository", async () => {
    // An aborted clone leaves a partial tree; `git clone` will not write into it.
    const dir = tempDir("cg-partial-");
    writeFileSync(path.join(dir, "leftover.txt"), "junk\n");
    await expect(refreshWorkspace(dir, originRepo())).resolves.toBe(false);
  });

  it("refuses a clone of a DIFFERENT repository occupying the path", async () => {
    // Ids are reused now. Analysing the wrong repository's code under this repo's row would be
    // worse than any error message.
    const first = originRepo();
    const second = originRepo();
    await expect(refreshWorkspace(workspaceFrom(first), second)).resolves.toBe(false);
  });

  it("ignores credentials, a trailing slash and a trailing .git when comparing remotes", async () => {
    const origin = originRepo();
    const dest = workspaceFrom(origin);
    git(dest, "remote", "set-url", "origin", "https://github.com/o/r.git");
    for (const spelling of [
      "https://github.com/o/r",
      "https://github.com/o/r/",
      "https://x-access-token:secret@github.com/o/r.git",
      "https://GitHub.com/o/r",
    ]) {
      await expect(refreshWorkspace(dest, spelling), spelling).resolves.toBe(true);
    }
    await expect(refreshWorkspace(dest, "https://github.com/o/other")).resolves.toBe(false);
  });

  it("adopts the workspace even when the remote cannot be reached", async () => {
    // Offline must not fail the index: the tree that is present is still the thing to analyse.
    const dest = workspaceFrom(originRepo());
    git(dest, "remote", "set-url", "origin", "https://github.com/o/r.git");
    await expect(refreshWorkspace(dest, "https://github.com/o/r.git")).resolves.toBe(true);
    expect(readFileSync(path.join(dest, "README.md"), "utf8")).toBe("one\n");
  });
});

describe("cloneRepo into an occupied destination", () => {
  it("returns the existing workspace instead of failing on a non-empty directory", async () => {
    /*
     * The exact regression. Before the fix this rejected with git's "destination path already
     * exists and is not an empty directory". The origin is an `https` URL that is never
     * contacted: the remote matches, so the reuse path is taken and the unreachable fetch is
     * swallowed by design.
     */
    const dest = workspaceFrom(originRepo());
    git(dest, "remote", "set-url", "origin", "https://github.com/o/r.git");
    await expect(cloneRepo("https://github.com/o/r", dest)).resolves.toBe(dest);
    expect(readFileSync(path.join(dest, "README.md"), "utf8")).toBe("one\n");
  });

  it("still refuses a URL that is not an https git URL", async () => {
    // The SSRF control is not relaxed by any of the above.
    const dest = path.join(tempDir("cg-ws-"), "repo");
    mkdirSync(dest, { recursive: true });
    await expect(cloneRepo("/etc", dest)).rejects.toThrow(/Invalid repository URL/);
  });
});
