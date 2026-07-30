import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * ADR-008: "The Health Score is the single headline metric, and it reports its own coverage —
 * a score computed over 40% analysed LOC can no longer masquerade as one computed over 98%."
 *
 * The walk drops files for four reasons and used to count NONE of them, so a partial analysis
 * rendered identically to a complete one.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-cov-"));
  trees.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("scan coverage", () => {
  it("is reported at all", async () => {
    const r = await indexRepo(repo({ "src/a.ts": "export const a = 1;\n" }));
    expect(r.coverage).toBeDefined();
  });

  it("counts files with no language mapping separately from files analysed", async () => {
    // THE BUG THIS PINS. `filesAnalysed` was briefly set to the walk's output, which still
    // included files the scan then dropped for having no language — overstating coverage by
    // 176 files on this repository. Overstating coverage inside the coverage report is the
    // precise failure ADR-008 exists to prevent.
    const r = await indexRepo(
      repo({
        "src/a.ts": "export const a = 1;\n",
        "logo.png": "\x89PNG\r\n",
        "data.bin": "\x00\x01\x02",
        "notes.xyz": "whatever",
      }),
    );
    const c = r.coverage!;
    expect(c.skippedNoLanguage).toBeGreaterThanOrEqual(3);
    expect(c.filesAnalysed).toBe(c.filesKept - c.skippedNoLanguage);
    expect(c.filesAnalysed).toBeLessThan(c.filesKept);
  });

  it("holds the accounting invariant on a real tree", async () => {
    const r = await indexRepo(".");
    const c = r.coverage!;
    // Every file seen is either kept or was too large; every kept file is either analysed or
    // had no language. If these drift, some category of skip is going uncounted again.
    expect(c.filesKept + c.skippedTooLarge).toBe(c.filesSeen);
    expect(c.filesAnalysed + c.skippedNoLanguage).toBe(c.filesKept);
  });

  it("counts a file over the size cap", async () => {
    // MAX_FILE_BYTES is 400_000.
    const r = await indexRepo(
      repo({ "src/a.ts": "export const a = 1;\n", "src/huge.ts": "//" + "x".repeat(450_000) }),
    );
    expect(r.coverage!.skippedTooLarge).toBe(1);
    // And the oversized file must not be counted as analysed.
    expect(r.coverage!.filesKept).toBe(r.coverage!.filesSeen - 1);
  });

  it("reports capHit false when the walk completed", async () => {
    const r = await indexRepo(repo({ "src/a.ts": "export const a = 1;\n" }));
    expect(r.coverage!.capHit).toBe(false);
    expect(r.coverage!.unvisitedDirs).toBe(0);
  });

  it("counts LOC only for files it actually scanned", async () => {
    const r = await indexRepo(
      repo({ "src/a.ts": "const a = 1;\nconst b = 2;\n", "blob.bin": "x\n".repeat(999) }),
    );
    const c = r.coverage!;
    // The 999-line binary contributes nothing — it has no language.
    expect(c.locAnalysed).toBeLessThan(100);
    expect(c.locAnalysed).toBe(r.loc);
  });
});
