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

  /*
   * A FULL index of this repository, so it is budgeted like the other whole-repo tests
   * (`signals-integration.test.ts` takes 120s for the same reason). It runs in ~20s alone and
   * comfortably over vitest's 30s default when the suite runs it beside everything else — a
   * timeout there measures the machine's parallelism, not this invariant.
   */
  it("holds the accounting invariant on a real tree", { timeout: 120_000 }, async () => {
    const r = await indexRepo(".");
    const c = r.coverage!;
    /**
     * Every file seen lands in exactly one bucket — kept, too large, or excluded by the
     * project's own `.gitignore` — and every kept file is either analysed or had no language.
     * If these drift, some category of skip is going uncounted again.
     *
     * `skippedIgnored` joined this SUM rather than sitting beside it: a skip category that is
     * reported but never reconciled is exactly how the last one went unnoticed. It counts
     * ignored FILES only — a wholly-ignored directory is pruned unentered, as `node_modules`
     * is, so its contents are never "seen" and belong in no bucket.
     */
    expect(c.filesKept + c.skippedTooLarge + (c.skippedIgnored ?? 0)).toBe(c.filesSeen);
    expect(c.filesAnalysed + c.skippedNoLanguage).toBe(c.filesKept);
  });

  it("counts a file over the size cap", async () => {
    // `CG_MAX_FILE_BYTES` unset, so the cap is its 400_000 default.
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

/**
 * The size cap used to be a bare `400_000` in `indexer.ts` while its sibling `CG_MAX_FILES`
 * was already an env var. Both decide what the Health Score is computed over, so both have to
 * be movable by the operator who has to live with the score.
 */
describe("the size cap is configurable", () => {
  const KEY = "CG_MAX_FILE_BYTES";
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  /** One file either side of the configured limit, both far under the 400_000 default. */
  function twoFiles(): string {
    return repo({
      "src/small.ts": `export const small = ${"1".repeat(200)};\n`,
      "src/large.ts": `export const large = ${"1".repeat(4_000)};\n`,
    });
  }

  it("skips only the file above the configured limit", async () => {
    process.env[KEY] = "1000";
    const c = (await indexRepo(twoFiles())).coverage!;
    expect(c.skippedTooLarge).toBe(1);
    expect(c.filesKept).toBe(c.filesSeen - 1);
    expect(c.filesAnalysed).toBe(1);
  });

  /**
   * The same tree at the default keeps both files — otherwise the assertion above would pass
   * for a fixture that was oversized all along and prove nothing about the variable.
   */
  it("keeps both files when the limit is left at its default", async () => {
    delete process.env[KEY];
    const c = (await indexRepo(twoFiles())).coverage!;
    expect(c.skippedTooLarge).toBe(0);
    expect(c.filesAnalysed).toBe(2);
  });

  /**
   * Read per walk, not once at module load: an import-time snapshot would make the variable
   * take effect only for a process that set it before `indexer.ts` was evaluated.
   */
  it("is read at walk time, so a value set after import still applies", async () => {
    const root = twoFiles();
    process.env[KEY] = "1000";
    expect((await indexRepo(root)).coverage!.skippedTooLarge).toBe(1);
    process.env[KEY] = "400000";
    expect((await indexRepo(root)).coverage!.skippedTooLarge).toBe(0);
  });
});

describe("nested repositories are a different project", () => {
  /**
   * A directory with its own `.git` is a separate repository by git's own definition, and
   * folding it in attributes someone else's issues to yours.
   *
   * MEASURED ON CODEGRAPH'S OWN CHECKOUT before this existed. `apps/web/data/workspaces/` holds
   * the repositories the app has indexed — five clones, each with a `.git`. They were 54.2% of
   * the scanned tree and 77 of the 200 reported issues, so the self-index was majority foreign
   * code: 1161 tree paths -> 537, 129,632 LOC -> 65,846, score 44 -> 53.
   */
  function nested(): string {
    const root = mkdtempSync(path.join(tmpdir(), "cg-nested-"));
    trees.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/mine.ts"), "export const mine = 1;\n");

    // A clone living inside the repo, with its own .git — and a finding in it.
    //
    // NOT under `vendor/`: that name is already in SKIP_DIRS, so the walk never descends far
    // enough to see the nested `.git` and the skip is attributed to the wrong rule. The first
    // version of this fixture used it and asserted a count that could never happen.
    mkdirSync(path.join(root, "third_party/clone/.git"), { recursive: true });
    mkdirSync(path.join(root, "third_party/clone/src"), { recursive: true });
    writeFileSync(path.join(root, "third_party/clone/src/theirs.ts"), 'eval("nope");\n');
    return root;
  }

  it("does not descend into a directory containing .git", async () => {
    const r = await indexRepo(nested());
    expect(r.issues.filter((i) => i.file.includes("third_party/clone"))).toEqual([]);
    expect(r.coverage!.skippedNestedRepos).toBe(1);
  });

  it("counts the skip rather than dropping it silently", async () => {
    // ADR-008: "we ignored a nested repository" is exactly what the score must disclose.
    const r = await indexRepo(nested());
    expect(r.coverage!.skippedNestedRepos).toBeGreaterThan(0);
  });

  it("still analyses the scan root even though IT has a .git", async () => {
    // The check runs on the CHILD. If it ran on the root, asking to index any real repository
    // would return nothing at all — and indexing a clone directly must keep working, which is
    // exactly what CodeGraph does for every repo it is given.
    const root = nested();
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const r = await indexRepo(root);
    expect(r.coverage!.filesAnalysed).toBeGreaterThan(0);
    expect(r.loc).toBeGreaterThan(0);
  });

  it("skips a submodule, whose .git is a FILE not a directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cg-sub-"));
    trees.push(root);
    mkdirSync(path.join(root, "sub"), { recursive: true });
    // Git writes a `.git` FILE containing a gitdir pointer for submodules.
    writeFileSync(path.join(root, "sub/.git"), "gitdir: ../.git/modules/sub\n");
    writeFileSync(path.join(root, "sub/x.ts"), 'eval("nope");\n');
    writeFileSync(path.join(root, "main.ts"), "export const a = 1;\n");

    const r = await indexRepo(root);
    expect(r.coverage!.skippedNestedRepos).toBe(1);
    expect(r.issues.filter((i) => i.file.includes("sub/"))).toEqual([]);
  });
});
