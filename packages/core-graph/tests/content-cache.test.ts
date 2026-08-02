import { describe, expect, it } from "vitest";
import { ContentCache, contentCache, syntacticSpans } from "../src/index";

/**
 * Content-addressed memo for per-file work.
 *
 * The case it pays for is the product indexing near-identical trees back to back:
 * `agents/executor.ts` indexes twice per remediation to measure the score delta, and the
 * Timeline indexes one snapshot per commit. Measured end to end on this repository:
 * **2,205ms cold, 1,220ms warm (55%)**, 614 hits and no new misses on the second pass.
 *
 * Not 5%. `ts.createProgram` plus `getTypeChecker` is ~766ms of the remaining time and cannot
 * be memoised per file - `oldProgram` reuse was measured at 751ms -> 682ms even with NOTHING
 * changed, so the floor is real and P6's exit criterion is corrected in PLAN.md rather than
 * chased.
 */
describe("ContentCache", () => {
  it("returns the memoised value for identical bytes", () => {
    const c = new ContentCache();
    let calls = 0;
    const compute = () => ++calls;
    expect(c.get("abc", ".ts", "v1", compute)).toBe(1);
    expect(c.get("abc", ".ts", "v1", compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it("misses on different content", () => {
    const c = new ContentCache();
    let calls = 0;
    const compute = () => ++calls;
    c.get("abc", ".ts", "v1", compute);
    c.get("abd", ".ts", "v1", compute);
    expect(calls).toBe(2);
  });

  it("misses when the version changes, so old logic is never served", () => {
    // The failure this prevents: change a rule table, forget to bump, and every cached repo
    // keeps reporting findings from the previous implementation. Silent and durable.
    const c = new ContentCache();
    let calls = 0;
    const compute = () => ++calls;
    c.get("abc", ".ts", "v1", compute);
    c.get("abc", ".ts", "v2", compute);
    expect(calls).toBe(2);
  });

  it("misses when the extension changes", () => {
    // Identical bytes analyse differently as .ts and .tsx.
    const c = new ContentCache();
    let calls = 0;
    const compute = () => ++calls;
    c.get("abc", ".ts", "v1", compute);
    c.get("abc", ".tsx", "v1", compute);
    expect(calls).toBe(2);
  });

  it("evicts the least recently used entry when full", () => {
    // The Timeline walks one snapshot per commit; unbounded, this holds every version of every
    // file for the life of the process.
    const c = new ContentCache(2);
    c.get("a", ".ts", "v", () => 1);
    c.get("b", ".ts", "v", () => 2);
    c.get("a", ".ts", "v", () => 99); // refresh "a", making "b" the oldest
    c.get("c", ".ts", "v", () => 3); // evicts "b"
    expect(c.stats().entries).toBe(2);
    let recomputed = false;
    c.get("b", ".ts", "v", () => {
      recomputed = true;
      return 2;
    });
    expect(recomputed).toBe(true);
  });

  it("counts hits and misses", () => {
    const c = new ContentCache();
    c.get("a", ".ts", "v", () => 1);
    c.get("a", ".ts", "v", () => 1);
    expect(c.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("does not change what syntacticSpans returns", () => {
    // The property that matters: a memo must be invisible. Compared against a fresh
    // computation of the same input via a distinct version key, which forces a real recompute.
    const src = 'const t = `a${x}b`; // note\nconst s = "str";\n';
    const cached = syntacticSpans(src, ".ts");
    const again = syntacticSpans(src, ".ts");
    expect(again).toEqual(cached);
    contentCache.clear();
    expect(syntacticSpans(src, ".ts")).toEqual(cached);
  });
});
