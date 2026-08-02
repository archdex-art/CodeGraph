import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { churnByFile, cleanup, resolveLocalDir } from "../src/index";

/**
 * `acquire.ts`, moved here from `apps/web/src/lib/indexer.ts` (LLD §13.2).
 *
 * These two functions had no direct coverage before the move — `cloneRepo`'s
 * token-redaction path was tested (apps/web/tests/security-hardening.test.ts),
 * but `resolveLocalDir` and the churn scan were only ever exercised through a
 * full index. They are package surface now, so they get their own tests.
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-acquire-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveLocalDir", () => {
  it("returns an absolute path for a real directory", () => {
    const dir = tempDir();
    expect(resolveLocalDir(dir)).toBe(path.resolve(dir));
  });

  it("rejects a path that does not exist", () => {
    // The message includes the resolved path deliberately: local-folder indexing
    // is a self-hosting feature and a typo is the common case, so the operator
    // needs to see what it actually resolved to.
    const missing = path.join(tempDir(), "nope");
    expect(() => resolveLocalDir(missing)).toThrow(/does not exist/);
  });

  it("rejects a file, because indexing walks a tree", () => {
    const dir = tempDir();
    const file = path.join(dir, "a.ts");
    writeFileSync(file, "export const a = 1;");
    expect(() => resolveLocalDir(file)).toThrow(/Not a directory/);
  });

  it("resolves a relative path against the process cwd rather than passing it through", () => {
    // A relative path reaching the walker unresolved would make the analysed root
    // depend on where the process happened to start.
    expect(path.isAbsolute(resolveLocalDir("."))).toBe(true);
  });
});

describe("churnByFile", () => {
  it("returns an empty map for a directory that is not a git repo", () => {
    // A local folder under no version control is a supported input, not an error:
    // churn is an enrichment, so its absence must not fail an analysis.
    expect(churnByFile(tempDir()).size).toBe(0);
  });

  it("counts commits per file in a real repository", () => {
    const dir = tempDir();
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    };
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    writeFileSync(path.join(dir, "hot.ts"), "export const a = 1;");
    writeFileSync(path.join(dir, "cold.ts"), "export const b = 1;");
    git("add", ".");
    git("commit", "--quiet", "-m", "first");

    // hot.ts changes again; cold.ts does not. Churn must separate them, which is
    // the whole signal Task 6.11 depends on.
    writeFileSync(path.join(dir, "hot.ts"), "export const a = 2;");
    git("add", "hot.ts");
    git("commit", "--quiet", "-m", "second");

    const churn = churnByFile(dir);
    expect(churn.get("hot.ts")).toBe(2);
    expect(churn.get("cold.ts")).toBe(1);
  });
});

describe("cleanup", () => {
  it("removes a directory tree", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "nested", "a.ts"), "export const a = 1;");

    cleanup(dir);

    expect(() => resolveLocalDir(dir)).toThrow(/does not exist/);
  });

  it("never throws on a path that is already gone", () => {
    // Callers use this in `finally`. Throwing here would replace the error they
    // are already handling with a less useful one.
    expect(() => cleanup(path.join(tempDir(), "never-existed"))).not.toThrow();
  });
});
