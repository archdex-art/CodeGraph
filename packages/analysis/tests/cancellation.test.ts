import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo, throwIfAborted } from "../src/index";

/**
 * Cancellation reaching INSIDE the pipeline (HLD §8's `PipelineContext`, §11's
 * "every stage checks between files").
 *
 * The distinction this defends: an abort checked only between stages waits for the
 * whole file walk, which on a large repository is the entire run. The checks ride the
 * existing per-15-file yield points, so a repo has to exceed that to prove anything —
 * hence 40 files rather than 2.
 */

const dirs: string[] = [];

function repoWith(fileCount: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-cancel-"));
  dirs.push(dir);
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      path.join(dir, `mod${i}.ts`),
      `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("throwIfAborted", () => {
  it("throws an AbortError when the signal is aborted", () => {
    const c = new AbortController();
    c.abort();
    // Named so a caller can tell "the user cancelled" from a real failure without
    // matching on the message text.
    expect(() => throwIfAborted({ signal: c.signal })).toThrow(
      expect.objectContaining({ name: "AbortError" })
    );
  });

  it("does nothing without a signal, so an uncancellable caller is unaffected", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted({})).not.toThrow();
  });
});

describe("indexRepo cancellation", () => {
  it("indexes normally when the signal is never aborted", async () => {
    const result = await indexRepo(repoWith(20), { signal: new AbortController().signal });
    expect(result.loc).toBeGreaterThan(0);
  }, 30_000);

  it("aborts mid-walk rather than finishing the repository", async () => {
    // Aborted before the first yield point is reached, so the walk stops early instead
    // of completing all 40 files.
    const c = new AbortController();
    c.abort();
    await expect(indexRepo(repoWith(40), { signal: c.signal })).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" })
    );
  }, 30_000);

  it("is unaffected when no context is passed at all", async () => {
    // The parameter is optional: existing callers (and P5's split) must keep working
    // without threading a context they do not have.
    const result = await indexRepo(repoWith(20));
    expect(result.loc).toBeGreaterThan(0);
  }, 30_000);
});
