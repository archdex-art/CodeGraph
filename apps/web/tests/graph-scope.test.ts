import { describe, expect, it } from "vitest";
import { inScope } from "@/components/CodeIntelPanel";

/**
 * The predicate that lets a click in any graph view drive one inspector.
 *
 * Three id vocabularies meet in it — posix file paths and directory paths from
 * `buildVizGraph`, top-level module ids with a `(root)` sentinel from
 * `buildModuleGraph`, and symbol `file` fields carrying the host separator. A
 * mismatch does not throw; it silently scopes to nothing, and an inspector that
 * says "No symbols extracted here" for a file full of symbols is indistinguishable
 * from an unsupported language. So the vocabularies are pinned here.
 */
describe("inScope", () => {
  it("matches a file against its own path", () => {
    expect(inScope("src/lib/store.ts", "src/lib/store.ts")).toBe(true);
    expect(inScope("src/lib/store.ts", "src/lib/other.ts")).toBe(false);
  });

  it("matches every file under a directory scope", () => {
    expect(inScope("src/lib/store.ts", "src")).toBe(true);
    expect(inScope("src/lib/store.ts", "src/lib")).toBe(true);
    expect(inScope("tests/store.test.ts", "src")).toBe(false);
  });

  it("respects the segment boundary rather than a bare prefix", () => {
    // `srcgen/` is not inside `src/`. A `startsWith(scope)` without the separator
    // would pull an unrelated sibling directory into the scope.
    expect(inScope("srcgen/a.ts", "src")).toBe(false);
    expect(inScope("src2/a.ts", "src")).toBe(false);
  });

  it("treats the module graph's (root) sentinel as files at the repository root", () => {
    // `buildModuleGraph` emits "(root)" — not "." — for files with no directory.
    expect(inScope("index.js", "(root)")).toBe(true);
    expect(inScope("readme.md", "(root)")).toBe(true);
    expect(inScope("src/index.js", "(root)")).toBe(false);
  });

  it("treats the viz graph's '.' root as the whole repository", () => {
    // `ensureDir` emits "." for the root directory node, which contains everything.
    expect(inScope("index.js", ".")).toBe(true);
    expect(inScope("src/deep/nested/a.ts", ".")).toBe(true);
  });

  it("normalises host separators so a Windows-indexed symbol still matches", () => {
    // Symbol `file` fields carry `path.sep`; viz node ids are always posix.
    expect(inScope("src\\lib\\store.ts", "src/lib")).toBe(true);
    expect(inScope("src\\lib\\store.ts", "src/lib/store.ts")).toBe(true);
    expect(inScope("index.js", "(root)")).toBe(true);
  });
});
