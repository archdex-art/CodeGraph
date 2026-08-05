import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkoutBranch, createBranch, diffCommitsFile, getCommitDiffFiles } from "../src/index";

/**
 * ARGUMENT injection, which is not command injection and was not covered by the absence of a
 * shell. Every git call here already used `execFile` with an argv array, and the file's own
 * header called that sufficient. It is not: a value that reaches argv unvalidated is read by
 * GIT as an option, and two of them were live and anonymously reachable against a
 * public-bucket repository.
 *
 * Run against a real git repository on purpose. The vulnerability is in what git's own
 * argument parser does with the token, so a fake would only assert my beliefs about git's CLI
 * — the same reasoning as `log-limit.test.ts`. The first two tests below therefore prove the
 * PRIMITIVE still exists in git (so the guard is not defending against nothing), and the rest
 * prove our wrappers refuse to hand it the input.
 */
let dir: string;
let secretFile: string;
let writeTarget: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cg-argv-"));
  secretFile = path.join(dir, "secret.txt");
  writeTarget = path.join(dir, "planted");
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "Test");
  writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  writeFileSync(secretFile, "SECRET_TOKEN_ABC123\nsecond-secret-line\n", "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("git argument injection", () => {
  it("git itself still leaks file contents through --pathspec-from-file", () => {
    // The primitive, unmediated. If a future git stops doing this the guard becomes belt and
    // braces rather than a fix — worth knowing, and worth failing loudly about, because the
    // reverse (quietly assuming git is safe) is exactly how this shipped.
    let stderr = "";
    try {
      execFileSync("git", ["checkout", `--pathspec-from-file=${secretFile}`], { cwd: dir, stdio: "pipe" });
    } catch (e) {
      // Narrowed rather than cast: execFileSync's throw is typed `unknown`, and asserting a
      // shape here would make the test pass on an error that never carried stderr at all.
      stderr = e && typeof e === "object" && "stderr" in e ? String(e.stderr) : "";
    }
    expect(stderr).toContain("SECRET_TOKEN_ABC123");
  });

  it("refuses an option-shaped branch name instead of reading a file", async () => {
    // The exploit: POST /api/repos/:id/git {"op":"checkout","name":"--pathspec-from-file=/etc/passwd"}.
    // git printed one `error: pathspec '<line>'` per line of that file, and the route forwards
    // git's stderr to the client at 409 — an unauthenticated arbitrary file read.
    await expect(checkoutBranch(dir, `--pathspec-from-file=${secretFile}`)).rejects.toThrow(/must not start with/);
  });

  it("refuses an option-shaped branch name on create, in both slots", async () => {
    await expect(createBranch(dir, "--help")).rejects.toThrow(/must not start with/);
    await expect(createBranch(dir, "ok", "--help")).rejects.toThrow(/must not start with/);
  });

  it("refuses an option-shaped revision instead of writing a file", async () => {
    // `${base}..${head}` is ONE argv token, so a leading dash on `base` makes the whole token
    // an option: `--output=/path..HEAD` had `git diff` create that file. Both diff helpers
    // swallow errors, so the write was silent — hence the explicit existsSync assertion.
    if (existsSync(writeTarget)) unlinkSync(writeTarget);
    await expect(diffCommitsFile(dir, `--output=${writeTarget}`, "HEAD", "a.txt")).rejects.toThrow(
      /must not start with/,
    );
    await expect(getCommitDiffFiles(dir, `--output=${writeTarget}`, "HEAD")).rejects.toThrow(
      /must not start with/,
    );
    expect(existsSync(writeTarget)).toBe(false);
  });

  it("refuses a dash on the head side too", async () => {
    // The head half is the one an implementer forgets: the token is base..head, and
    // `HEAD..--output=x` is just as much an option as the other order.
    await expect(diffCommitsFile(dir, "HEAD", "--output=x", "a.txt")).rejects.toThrow(/must not start with/);
  });

  it("still does ordinary work with legitimate refs", async () => {
    // The guard must not be a blanket refusal: a rejection that also breaks the feature would
    // be found by users rather than by this test.
    await expect(getCommitDiffFiles(dir, "HEAD", "HEAD")).resolves.toEqual([]);
    await expect(diffCommitsFile(dir, "HEAD", "HEAD", "a.txt")).resolves.toBe("");
    await expect(createBranch(dir, "feature/ok")).resolves.toBeUndefined();
    await expect(checkoutBranch(dir, "feature/ok")).resolves.toBeUndefined();
  });
});
