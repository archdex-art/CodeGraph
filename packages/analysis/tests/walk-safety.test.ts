import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * Two properties of the walk that are not about analysis quality at all.
 *
 * SYMLINKS. The walk used `statSync`, which follows them. A repository is attacker-authored
 * input, and `evil.ts -> /proc/self/environ` therefore had its target read into the pipeline;
 * any detector rule that matched put up to 120 characters of it into a finding's `evidence`,
 * which `GET /api/repos/:id` serves. The web process's environment holds `CG_SESSION_SECRET`,
 * `GITHUB_OAUTH_CLIENT_SECRET` and `ANTHROPIC_API_KEY`, and the secret rules are exactly the
 * ones an environment dump trips.
 *
 * ORDER. The walk is capped at `MAX_FILES`, so traversal order decides which files a large
 * repository even gets analysed over. Unsorted, that was the host filesystem's answer, and the
 * Health Score for identical bytes could differ between two machines — under a product whose
 * central claim is determinism.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** Repo-relative paths of every file the walk actually analysed, in walk order. */
const analysedFiles = (r: Awaited<ReturnType<typeof indexRepo>>): string[] =>
  r.viz.nodes.filter((n) => n.kind === "file").map((n) => n.id);

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-walk-"));
  trees.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("the walk does not follow symlinks out of the repository", () => {
  it("does not read a file symlinked from outside the tree", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "cg-outside-"));
    trees.push(outside);
    // Shaped to trip the hardcoded-secret rule, which is the realistic disclosure channel.
    writeFileSync(
      path.join(outside, "env.ts"),
      'const api_key = "sk-live-4f9c2ab77e1d40aa9d3b6c5e8f1027bd";\n',
      "utf8",
    );

    const root = repo({ "src/real.ts": "export const a = 1;\n" });
    symlinkSync(path.join(outside, "env.ts"), path.join(root, "src", "leak.ts"));

    const r = await indexRepo(root);
    expect(r.issues.some((i) => i.file === "src/leak.ts")).toBe(false);
    expect(JSON.stringify(r.issues)).not.toContain("sk-live-4f9c2ab77e1d40aa9d3b6c5e8f1027bd");
  });

  it("does not descend through a symlinked directory", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "cg-outside-dir-"));
    trees.push(outside);
    writeFileSync(path.join(outside, "secret.ts"), "export const s = 1;\n", "utf8");

    const root = repo({ "src/real.ts": "export const a = 1;\n" });
    symlinkSync(outside, path.join(root, "vendored"));

    const r = await indexRepo(root);
    expect(analysedFiles(r).some((f) => f.startsWith("vendored/"))).toBe(false);
  });

  it("still analyses the repository's own files", async () => {
    // The regression the fix above could plausibly cause: refusing everything.
    const root = repo({ "src/real.ts": "export const a = 1;\n" });
    symlinkSync(path.join(root, "src", "real.ts"), path.join(root, "src", "alias.ts"));

    const r = await indexRepo(root);
    expect(analysedFiles(r)).toContain("src/real.ts");
  });
});

describe("the walk is deterministic", () => {
  it("returns files in a stable order across runs", async () => {
    const root = repo({
      "z/last.ts": "export const z = 1;\n",
      "a/first.ts": "export const a = 1;\n",
      "m/mid.ts": "export const m = 1;\n",
      "b.ts": "export const b = 1;\n",
    });

    const first = analysedFiles(await indexRepo(root));
    const second = analysedFiles(await indexRepo(root));
    expect(second).toEqual(first);

    // Repeatability alone is not the property: an unsorted `readdirSync` is also repeatable
    // on one machine and differs on the next. What makes the order machine-independent is
    // that every directory is visited in sorted name order, so assert THAT — the walk is a
    // depth-first traversal that emits a directory's files before descending, which is why
    // the flat list is not globally sorted and must not be asserted as if it were.
    const byParent = new Map<string, string[]>();
    for (const f of first) {
      const parent = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
      const siblings = byParent.get(parent);
      if (siblings) siblings.push(f);
      else byParent.set(parent, [f]);
    }
    for (const siblings of byParent.values()) {
      expect(siblings).toEqual([...siblings].sort());
    }

    // And the directories themselves are entered in sorted order.
    const dirsInOrder = [...new Set(first.map((f) => (f.includes("/") ? f.slice(0, f.indexOf("/")) : ".")))];
    expect(dirsInOrder).toEqual([".", "a", "m", "z"]);
  });
});

describe("the walk respects the project's own .gitignore", () => {
  /**
   * The fixed skip list knows `node_modules` and `dist`; it cannot know what THIS project
   * considers generated. Measured on CodeGraph's own checkout before this existed:
   * `apps/web/data/` is gitignored because it holds the running app's SQLite database and its
   * cached timeline snapshots, and the walk read 54 JSON files totalling 581,639 lines out of
   * it — against 29,368 lines of real TypeScript in the same tree. `apps` was reported and
   * coloured as a JSON module, and because LOC is the denominator of the Health Score, the
   * score itself was diluted by the tool's own database.
   */
  function gitRepo(files: Record<string, string>, ignore: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "cg-ignore-"));
    trees.push(root);
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    };
    run("init", "-q");
    run("config", "user.email", "a@b.c");
    run("config", "user.name", "T");
    writeFileSync(path.join(root, ".gitignore"), ignore, "utf8");
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    run("add", "-A");
    run("commit", "-qm", "init");
    return root;
  }

  it("does not analyse a gitignored directory", async () => {
    const root = gitRepo(
      {
        "src/real.ts": "export const a = 1;\n",
        "data/generated.ts": "export const junk = 1;\n",
      },
      "data/\n",
    );
    const files = analysedFiles(await indexRepo(root));
    expect(files).toContain("src/real.ts");
    expect(files.some((f) => f.startsWith("data/"))).toBe(false);
  });

  it("does not analyse a gitignored file beside tracked ones", async () => {
    const root = gitRepo(
      { "src/real.ts": "export const a = 1;\n", "src/secret.ts": "export const s = 1;\n" },
      "src/secret.ts\n",
    );
    expect(analysedFiles(await indexRepo(root))).toEqual(["src/real.ts"]);
  });

  it("counts an ignored FILE in the coverage report", async () => {
    // ADR-008: the score reports the coverage it was computed over. `skippedIgnored` counts
    // ignored files the walk encountered, and it participates in the accounting invariant in
    // `coverage.test.ts` — a skip category that is reported but never reconciled is how the
    // previous one went unnoticed.
    const root = gitRepo(
      { "src/real.ts": "export const a = 1;\n", "src/secret.ts": "export const s = 1;\n" },
      "src/secret.ts\n",
    );
    const cov = (await indexRepo(root)).coverage!;
    expect(cov.skippedIgnored).toBe(1);
    expect(cov.filesKept + cov.skippedTooLarge + (cov.skippedIgnored ?? 0)).toBe(cov.filesSeen);
  });

  it("does not count a pruned directory as skipped files it never counted", async () => {
    // A wholly-ignored tree is never entered, exactly as `node_modules` is not, so its contents
    // are not "seen" and belong in no bucket. Inventing a count for them would put a number in
    // the coverage report that no traversal produced — and would break the invariant above.
    const root = gitRepo(
      { "src/real.ts": "export const a = 1;\n", "data/x.ts": "export const j = 1;\n" },
      "data/\n",
    );
    const cov = (await indexRepo(root)).coverage!;
    expect(analysedFiles(await indexRepo(root))).not.toContain("data/x.ts");
    expect(cov.filesKept + cov.skippedTooLarge + (cov.skippedIgnored ?? 0)).toBe(cov.filesSeen);
  });

  it("still analyses an untracked file the project has NOT ignored", async () => {
    // `--others --exclude-standard` is "tracked plus untracked-and-not-ignored". A rule that
    // only kept tracked files would hide every new file until it was committed.
    const root = gitRepo({ "src/real.ts": "export const a = 1;\n" }, "data/\n");
    writeFileSync(path.join(root, "src", "fresh.ts"), "export const f = 1;\n", "utf8");
    expect(analysedFiles(await indexRepo(root))).toContain("src/fresh.ts");
  });

  it("analyses everything in a directory that is not a git checkout", async () => {
    // A plain folder is a supported input and has no opinion to respect; filtering it to
    // nothing would be far worse than analysing a stray generated file.
    const root = repo({ "src/a.ts": "export const a = 1;\n", "data/b.ts": "export const b = 1;\n" });
    const files = analysedFiles(await indexRepo(root));
    expect(files).toContain("src/a.ts");
    expect(files).toContain("data/b.ts");
  });
});
