import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coverageNote } from "@/lib/coverage-note";
import type { ScanCoverage } from "@/lib/types";

/**
 * What the Health Score says it was computed over.
 *
 * MEASURED: `microsoft/TypeScript` holds 39,334 analysable source files, and the default
 * `CG_MAX_FILES=4000` stops the walk at roughly a tenth of it. `coverage.capHit` recorded that
 * and the report rendered a confident percentage over the truncated denominator — publishing a
 * score computed over 10% of a repository as if it were THE score, which is the same class of
 * problem as claiming in the README what the code does not do (CLAUDE.md §5).
 *
 * The behavioural half runs the real copy function. The scanning half is a ratchet: the
 * disclosure only works while there is ONE of it, and an inlined second sentence in a component
 * is invisible to every other kind of test — this suite runs in the `node` environment, so
 * nothing here can render JSX.
 */
const SRC = path.resolve(__dirname, "../src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sources(SRC).map((f) => [path.relative(SRC, f), readFileSync(f, "utf8")] as const);
const REPORT_PAGE = path.join("app", "repos", "[id]", "page.tsx");

function read(name: string): string {
  const found = FILES.find(([f]) => f === name);
  expect(found, `${name} is not in the scanned sources`).toBeDefined();
  return found![1];
}

/** The measured TypeScript shape: the walk stopped at 4,000 kept files with directories left. */
function capped(over: Partial<ScanCoverage> = {}): ScanCoverage {
  return {
    filesSeen: 4018,
    filesKept: 4000,
    filesAnalysed: 3787,
    skippedNoLanguage: 213,
    skippedTooLarge: 18,
    skippedUnreadable: 0,
    skippedNestedRepos: 0,
    skippedIgnored: 0,
    locAnalysed: 812_004,
    capHit: true,
    unvisitedDirs: 1204,
    ...over,
  };
}

/** The pre-existing shape, unchanged: this is the mechanism the cap disclosure extends. */
function whole(): ScanCoverage {
  return {
    filesSeen: 11,
    filesKept: 11,
    filesAnalysed: 6,
    skippedNoLanguage: 5,
    skippedTooLarge: 0,
    skippedUnreadable: 0,
    skippedNestedRepos: 0,
    skippedIgnored: 0,
    locAnalysed: 400,
    capHit: false,
    unvisitedDirs: 0,
  };
}

describe("the coverage sentence when the walk finished", () => {
  const note = coverageNote(whole());

  it("keeps the percentage sentence it always had", () => {
    expect(note.scope).toBe("Scored over 55% of files (6 of 11, 5 unsupported).");
  });

  it("says nothing about a sample or about the cap", () => {
    expect(note.sample).toBeNull();
    expect(note.scope).not.toMatch(/sample/i);
    expect(note.scope).not.toContain("CG_MAX_FILES");
  });

  it("reports an unmeasurable percentage as unknown rather than as zero", () => {
    const empty = coverageNote({ ...whole(), filesSeen: 0, filesKept: 0, filesAnalysed: 0, skippedNoLanguage: 0 });
    expect(empty.scope).toBe("Scored over — of files (0 of 0).");
  });
});

describe("the coverage sentence when the file cap truncated the walk", () => {
  const note = coverageNote(capped());

  it("names the counts the walk actually produced", () => {
    expect(note.scope).toBe(
      "Scored over 3,787 of the 4,018 files the walk reached (18 over the size cap, 213 unsupported)."
    );
  });

  /**
   * THE BUG THIS PINS. `filesSeen` is what the walk ENCOUNTERED before breaking out, so
   * `filesAnalysed / filesSeen` is a fraction of the truncated walk and not of the repository —
   * it rendered as "Scored over 94% of files" for a repository the scan saw a tenth of. The
   * real total is unknown, and a percentage over an invented denominator is the larger lie.
   */
  it("prints no percentage, because the denominator is truncated too", () => {
    expect(note.scope).not.toMatch(/%/);
  });

  it("says the score is a sample, and bounds what was left out", () => {
    expect(note.sample).toBe(
      "The walk stopped at the CG_MAX_FILES cap with 1,204 directories left unvisited, so this is a sample of the repository, not all of it."
    );
  });

  /** A self-hoster can move the cap. A disclosure that does not name the lever is an apology. */
  it("names the environment variable that moves the cap", () => {
    expect(note.sample).toContain("CG_MAX_FILES");
  });

  it("omits the directory clause rather than printing a zero when the cap landed on the last one", () => {
    expect(coverageNote(capped({ unvisitedDirs: 0 })).sample).toBe(
      "The walk stopped at the CG_MAX_FILES cap, so this is a sample of the repository, not all of it."
    );
  });

  it("says `1 directory`, not `1 directories`", () => {
    expect(coverageNote(capped({ unvisitedDirs: 1 })).sample).toContain("1 directory left unvisited");
  });
});

describe("the disclosure has exactly one implementation", () => {
  it("scans the sources it claims to, so the suite cannot pass by finding nothing", () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it("is rendered by the report page from `coverageNote`, both halves of it", () => {
    const src = read(REPORT_PAGE);
    expect(src).toContain("coverageNote(");
    expect(src).toContain("coverage.scope");
    expect(src).toContain("coverage.sample");
  });

  /**
   * A component that recomputes the fraction is a SECOND disclosure, free to disagree with the
   * first — and the truncated-denominator percentage above is exactly what a re-inlined copy
   * brings back.
   */
  it.each(FILES.filter(([name]) => name !== "lib/coverage-note.ts"))(
    "%s does not recompute the coverage fraction itself",
    (_name, src) => {
      expect(src.match(/filesAnalysed\s*\/\s*[\w.]*filesSeen/g) ?? []).toEqual([]);
    }
  );

  /** The dashboard ranks by score, so its rows carry the marker rather than the sentence. */
  it("marks a sampled score in the dashboard's ranked table", () => {
    const src = read(path.join("app", "dashboard", "page.tsx"));
    expect(src).toContain("r.capHit");
    expect(src).toContain("CG_MAX_FILES");
  });
});
