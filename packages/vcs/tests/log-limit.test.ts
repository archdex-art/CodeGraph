import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { log } from "../src/index";

/**
 * `log()` interpolates its count into an argv token (`-30`), and its callers are HTTP
 * routes that pass `Number(searchParams.get("limit")) || 30` straight through. A caller
 * supplying `-5` produced the token `--5`, which git rejects with a usage error — a 500
 * for a merely malformed query string. `1.5` and `1e21` failed the same way, and an
 * enormous value was accepted, buffering an entire repository's history into one string.
 *
 * Run against a real git repository: the bug is in what git does with the argument, so a
 * fake would only assert my beliefs about git's CLI.
 */
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cg-gitlog-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "Test");
  for (let i = 0; i < 3; i++) {
    writeFileSync(path.join(dir, `f${i}.txt`), `x${i}\n`, "utf8");
    run("add", ".");
    run("commit", "-q", "-m", `commit ${i}`);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("log limit normalisation", () => {
  it("returns entries for a normal limit", async () => {
    expect(await log(dir, 2)).toHaveLength(2);
  });

  it("does not throw on a negative limit", async () => {
    // Was: git usage error out of `git log --5`, surfacing as a 500.
    const entries = await log(dir, -5);
    expect(entries).toHaveLength(1);
  });

  it("does not throw on a fractional or exponential limit", async () => {
    expect(await log(dir, 1.5)).toHaveLength(1);
    expect((await log(dir, 1e21)).length).toBeGreaterThan(0);
  });

  it("does not throw on zero or NaN", async () => {
    expect(await log(dir, 0)).toHaveLength(1);
    expect((await log(dir, Number.NaN)).length).toBe(3);
  });

  it("caps an enormous limit instead of reading unbounded history", async () => {
    // The repository only has 3 commits, so the cap is asserted on the argv rather than
    // the row count: anything above the ceiling must still succeed and stay bounded.
    expect((await log(dir, 10_000_000)).length).toBe(3);
  });
});
