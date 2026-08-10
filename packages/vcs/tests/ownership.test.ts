import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  authorStats,
  familiarity,
  fileOwnership,
  gitHunkLog,
  gitOwnership,
  identityKey,
  ownershipReport,
  parseGitLogHunks,
  recommendReviewers,
  staleAreas,
  symbolOwnership,
  type SymbolSpan,
} from "../src/ownership";
import { GIT_LOG_FORMAT, type Commit } from "../src/signals";

/**
 * Ownership, reviewers and symbol attribution, over hand-built history.
 *
 * Every function under test takes `readonly Commit[]` rather than a repository, which is the
 * same split `signalsFromCommits` uses and the reason none of this needs git: a fixture can
 * express "two spellings of one person, one of whom stopped committing in March" precisely,
 * and a real repository cannot be asked to.
 *
 * The window is fixed at 180 days with an explicit `now`, so "recent" and "stale" mean the
 * same thing on every machine and in every month. A test that derived `now` from the clock
 * would pass today and rot.
 */

const DAY = 86_400;
const NOW = 1_700_000_000; // fixed instant; nothing here reads the clock
const OPTS = { windowDays: 180, now: NOW } as const;

/** Days before `NOW`, as epoch seconds. */
const ago = (days: number): number => NOW - days * DAY;

function commit(partial: Partial<Commit> & { files: readonly string[]; at: number }): Commit {
  // `partial` spreads LAST so an explicit field always wins; every default above it is only a
  // default. `at` and `files` are required by the signature, so they always come from there.
  return {
    author: "Ada Lovelace",
    email: "ada@example.com",
    isFix: false,
    sha: "0".repeat(40),
    subject: "change",
    ...partial,
  };
}

describe("author identity", () => {
  it("treats two name spellings sharing an email as one person", () => {
    // The single most common shape in a real log: someone commits from a laptop and from CI,
    // or changes how they capitalise their name. Counting them twice halves every ownership
    // share and inflates the bus factor, which is the number people act on.
    const commits = [
      commit({ author: "Ada Lovelace", email: "ada@example.com", at: ago(10), files: ["a.ts"] }),
      commit({ author: "ada", email: "Ada@Example.com", at: ago(9), files: ["a.ts"] }),
    ];
    expect(identityKey(commits[0]!)).toBe(identityKey(commits[1]!));
    expect(authorStats(commits)).toHaveLength(1);
    expect(authorStats(commits)[0]!.commits).toBe(2);
  });

  it("keeps two people who share a name but not an email apart", () => {
    const commits = [
      commit({ author: "Alex", email: "alex@one.example", at: ago(10), files: ["a.ts"] }),
      commit({ author: "Alex", email: "alex@two.example", at: ago(9), files: ["a.ts"] }),
    ];
    expect(authorStats(commits)).toHaveLength(2);
  });

  it("excludes bots, which would otherwise be the most involved contributor", () => {
    // A dependency bot with hundreds of bumps outranks every human on any commit-count metric.
    const commits = [
      commit({ author: "Ada Lovelace", email: "ada@example.com", at: ago(10), files: ["a.ts"] }),
      commit({ author: "dependabot[bot]", email: "bot@github.com", at: ago(9), files: ["a.ts"] }),
      commit({ author: "dependabot[bot]", email: "bot@github.com", at: ago(8), files: ["a.ts"] }),
    ];
    expect(authorStats(commits).map((a) => a.name)).toEqual(["Ada Lovelace"]);
  });

  it("reports first and last activity, not just a count", () => {
    const commits = [
      commit({ at: ago(100), files: ["a.ts"] }),
      commit({ at: ago(5), files: ["a.ts"] }),
    ];
    const [ada] = authorStats(commits);
    expect(ada!.firstAt).toBe(ago(100));
    expect(ada!.lastAt).toBe(ago(5));
    expect(ada!.filesTouched).toBe(1);
  });
});

describe("file ownership", () => {
  const commits = [
    commit({ author: "Ada", email: "ada@x.example", at: ago(5), files: ["src/core.ts"] }),
    commit({ author: "Ada", email: "ada@x.example", at: ago(6), files: ["src/core.ts"] }),
    commit({ author: "Ada", email: "ada@x.example", at: ago(7), files: ["src/core.ts"] }),
    commit({ author: "Bob", email: "bob@x.example", at: ago(8), files: ["src/core.ts"] }),
  ];

  it("splits shares by commits touching the file, highest first", () => {
    const [core] = fileOwnership(commits, OPTS);
    expect(core!.path).toBe("src/core.ts");
    expect(core!.owners[0]!.author).toBe("Ada");
    expect(core!.owners[0]!.share).toBeCloseTo(0.75, 5);
    expect(core!.owners[1]!.share).toBeCloseTo(0.25, 5);
  });

  it("shares over one file sum to one", () => {
    const [core] = fileOwnership(commits, OPTS);
    const total = core!.owners.reduce((s, o) => s + o.share, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("reports a bus factor of 1 when one person holds the majority", () => {
    // "Fewest authors accounting for >= 50% of edits" — Ada alone is 75%.
    expect(fileOwnership(commits, OPTS)[0]!.busFactor).toBe(1);
  });

  it("reports a bus factor of 2 when no single author reaches half", () => {
    const even = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(5), files: ["s.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(6), files: ["s.ts"] }),
      commit({ author: "Cy", email: "cy@x.example", at: ago(7), files: ["s.ts"] }),
    ];
    expect(fileOwnership(even, OPTS)[0]!.busFactor).toBe(2);
  });

  it("measures staleness from the file's own last commit", () => {
    const mixed = [
      commit({ at: ago(3), files: ["fresh.ts"] }),
      commit({ at: ago(120), files: ["old.ts"] }),
    ];
    const byPath = new Map(fileOwnership(mixed, OPTS).map((f) => [f.path, f]));
    expect(byPath.get("fresh.ts")!.staleDays).toBe(3);
    expect(byPath.get("old.ts")!.staleDays).toBe(120);
  });

  it("marks a file orphaned only when every owner has gone quiet", () => {
    // Ada left; Bob is still here. `shared.ts` has a live owner and must not read as orphaned
    // just because it is old — that is the distinction the field exists to make.
    const commits2 = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(150), files: ["gone.ts", "shared.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(2), files: ["shared.ts"] }),
    ];
    const byPath = new Map(fileOwnership(commits2, OPTS).map((f) => [f.path, f]));
    expect(byPath.get("gone.ts")!.orphaned).toBe(true);
    expect(byPath.get("shared.ts")!.orphaned).toBe(false);
  });
});

describe("stale areas", () => {
  it("rolls files up into the directories nobody maintains", () => {
    const commits = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(160), files: ["legacy/a.ts", "legacy/b.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(1), files: ["active/c.ts"] }),
    ];
    const areas = staleAreas(commits, OPTS);
    const dirs = areas.filter((a) => a.kind === "directory").map((a) => a.path);
    expect(dirs).toContain("legacy");
    expect(dirs).not.toContain("active");
  });

  it("names the owners of a stale area, so it points at a person and not just a path", () => {
    const commits = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(160), files: ["legacy/a.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(1), files: ["active/c.ts"] }),
    ];
    const legacy = staleAreas(commits, OPTS).find((a) => a.path === "legacy/a.ts");
    expect(legacy?.owners).toContain("Ada");
  });

  it("marks a stale area orphaned only when its owners are also gone", () => {
    // Mutation-verified: forcing `orphaned: true` here used to pass, because nothing asserted
    // the field. Old and abandoned are different claims — a module Bob still maintains but
    // has not needed to touch is stale, not orphaned, and the two call for different actions.
    const commits = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(160), files: ["abandoned/a.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(155), files: ["quiet/b.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(1), files: ["elsewhere/c.ts"] }),
    ];
    const byPath = new Map(staleAreas(commits, OPTS).map((a) => [a.path, a]));
    expect(byPath.get("abandoned/a.ts")!.orphaned).toBe(true);
    expect(byPath.get("quiet/b.ts")!.orphaned).toBe(false);
  });
});

describe("familiarity", () => {
  const commits = [
    commit({ author: "Ada", email: "ada@x.example", at: ago(5), files: ["src/a.ts"] }),
    commit({ author: "Ada", email: "ada@x.example", at: ago(6), files: ["src/a.ts"] }),
    commit({ author: "Bob", email: "bob@x.example", at: ago(7), files: ["src/a.ts", "src/b.ts"] }),
  ];
  it("reports one author's share per file and per directory", () => {
    const f = familiarity(commits, "Ada");
    expect(f.matched).toBe(true);
    expect(f.files.find((e) => e.path === "src/a.ts")!.share).toBeCloseTo(2 / 3, 5);
    expect(f.directories.find((e) => e.path === "src")!.commits).toBe(2);
  });

  it("distinguishes an unknown author from one who has touched nothing", () => {
    // Both produce empty lists and they mean opposite things, which is why `matched` exists.
    expect(familiarity(commits, "Nobody At All").matched).toBe(false);
    expect(familiarity(commits, "Nobody At All").files).toHaveLength(0);
  });
});

describe("reviewer recommendation", () => {
  it("ranks the owner of the changed file first", () => {
    const commits = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(4), files: ["src/pay.ts"] }),
      commit({ author: "Ada", email: "ada@x.example", at: ago(5), files: ["src/pay.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(6), files: ["src/other.ts"] }),
    ];
    const recs = recommendReviewers(commits, ["src/pay.ts"], OPTS);
    expect(recs[0]!.author).toBe("Ada");
  });

  it("lets ownership outrank recency when the two disagree", () => {
    // Mutation-verified: zeroing the ownership weight left the test above green, because Ada
    // was BOTH the owner and the most recent committer, so recency alone produced the same
    // answer. Here Bob committed yesterday and Ada owns 4 of the 5 edits — if ownership does
    // not carry real weight, Bob wins and this goes red. Without a case where the components
    // disagree, a weighted ranking is untested no matter how many orderings you assert.
    const commits = [
      commit({ author: "Ada", email: "ada@x.example", at: ago(30), files: ["src/pay.ts"] }),
      commit({ author: "Ada", email: "ada@x.example", at: ago(31), files: ["src/pay.ts"] }),
      commit({ author: "Ada", email: "ada@x.example", at: ago(32), files: ["src/pay.ts"] }),
      commit({ author: "Ada", email: "ada@x.example", at: ago(33), files: ["src/pay.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(1), files: ["src/pay.ts"] }),
    ];
    const recs = recommendReviewers(commits, ["src/pay.ts"], OPTS);
    expect(recs.map((r) => r.author)).toEqual(["Ada", "Bob"]);
    expect(recs[0]!.score).toBeGreaterThan(recs[1]!.score);
  });

  it("lets recency decide when ownership is tied", () => {
    // The mirror of the case above, and mutation-verified the same way: zeroing the recency
    // weight leaves every other reviewer test green, because nothing else makes recency the
    // deciding term. Both authors own half of `src/pay.ts`; only the timestamps differ, so a
    // ranking that ignores recency cannot put Fresh first except by luck of the tie-break —
    // which is alphabetical, and would pick Aged.
    // Both are ACTIVE — inside the recent third of the window — so the hard inactivity
    // exclusion plays no part and only the recency term separates them.
    const commits = [
      commit({ author: "Aged", email: "aged@x.example", at: ago(50), files: ["src/pay.ts"] }),
      commit({ author: "Aged", email: "aged@x.example", at: ago(51), files: ["src/pay.ts"] }),
      commit({ author: "Fresh", email: "fresh@x.example", at: ago(2), files: ["src/pay.ts"] }),
      commit({ author: "Fresh", email: "fresh@x.example", at: ago(3), files: ["src/pay.ts"] }),
    ];
    const recs = recommendReviewers(commits, ["src/pay.ts"], OPTS);
    expect(recs.map((r) => r.author)).toEqual(["Fresh", "Aged"]);
  });

  it("excludes an author who has not committed in the recent window", () => {
    // Recommending someone who left is worse than recommending nobody: it looks like an answer.
    const commits = [
      commit({ author: "Ghost", email: "ghost@x.example", at: ago(170), files: ["src/pay.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(3), files: ["src/pay.ts"] }),
    ];
    expect(recommendReviewers(commits, ["src/pay.ts"], OPTS).map((r) => r.author)).not.toContain("Ghost");
  });

  it("excludes bots", () => {
    const commits = [
      commit({ author: "renovate[bot]", email: "bot@x.example", at: ago(2), files: ["src/pay.ts"] }),
      commit({ author: "Bob", email: "bob@x.example", at: ago(3), files: ["src/pay.ts"] }),
    ];
    const authors = recommendReviewers(commits, ["src/pay.ts"], OPTS).map((r) => r.author);
    expect(authors).toEqual(["Bob"]);
  });
  it("ranks by co-change strength, with the alphabet pulling the other way", () => {
    // Mutation-verified, and the construction is the point. An earlier version of this test
    // only asserted that a coupled-only reviewer APPEARED, which survived zeroing the coupling
    // weight: the same person still scored above zero on recency alone, so the term was never
    // actually exercised.
    //
    // Here neither Zed nor Amy has ever touched `schema.ts`, so ownership gives them nothing,
    // and both last committed on the same day, so recency gives them the same. The ONLY thing
    // separating them is how strongly their file co-changes with `schema.ts`: `migrations.ts`
    // moves with it in every commit, `docs.md` in one. With coupling weighed, Zed ranks first;
    // with the weight at zero they tie exactly and the alphabetical tie-break puts Amy first.
    // The names are chosen so the mutant's answer is the reverse of the correct one.
    const commits = [
      commit({ author: "Cara", email: "cara@x.example", at: ago(40), files: ["schema.ts", "migrations.ts"] }),
      commit({ author: "Cara", email: "cara@x.example", at: ago(41), files: ["schema.ts", "migrations.ts"] }),
      commit({ author: "Cara", email: "cara@x.example", at: ago(42), files: ["schema.ts", "migrations.ts"] }),
      commit({ author: "Cara", email: "cara@x.example", at: ago(43), files: ["schema.ts", "docs.md"] }),
      commit({ author: "Zed", email: "zed@x.example", at: ago(4), files: ["migrations.ts"] }),
      commit({ author: "Amy", email: "amy@x.example", at: ago(4), files: ["docs.md"] }),
    ];
    const recs = recommendReviewers(commits, ["schema.ts"], OPTS);
    const zed = recs.findIndex((r) => r.author === "Zed");
    const amy = recs.findIndex((r) => r.author === "Amy");
    expect(zed).toBeGreaterThanOrEqual(0);
    expect(amy).toBeGreaterThanOrEqual(0);
    expect(zed).toBeLessThan(amy);
    expect(recs[zed]!.score).toBeGreaterThan(recs[amy]!.score);
    // The reason must name the coupled file, not just assert a number moved.
    expect(recs[zed]!.reasons.join(" ")).toContain("migrations.ts");
  });
  it("breaks score ties by author name, so two runs agree", () => {
    // Determinism is the product's headline claim, and Map iteration order is not it.
    const commits = [
      commit({ author: "Zoe", email: "zoe@x.example", at: ago(4), files: ["s.ts"] }),
      commit({ author: "Amy", email: "amy@x.example", at: ago(4), files: ["s.ts"] }),
    ];
    const first = recommendReviewers(commits, ["s.ts"], OPTS).map((r) => r.author);
    const second = recommendReviewers(commits, ["s.ts"], OPTS).map((r) => r.author);
    expect(first).toEqual(second);
    expect(first).toEqual(["Amy", "Zoe"]);
  });
});

describe("hunk parsing", () => {
  const RS = "\x1e";
  const US = "\x1f";

  /** One `git log -p --unified=0` record, in the format `GIT_LOG_FORMAT` produces. */
  const record = (sha: string, body: string): string =>
    `${RS}${sha}${US}Ada${US}${ago(3)}${US}subject${US}ada@x.example\n${body}`;

  it("reads the POST-image range out of a hunk header", () => {
    const raw = record(
      "a".repeat(40),
      ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10 +10,3 @@", "+x", "+y", "+z"].join("\n"),
    );
    const [c] = parseGitLogHunks(raw);
    expect(c!.files[0]!.path).toBe("src/a.ts");
    expect(c!.files[0]!.ranges).toEqual([[10, 12]]);
  });

  it("keeps every hunk in a multi-hunk file", () => {
    const raw = record(
      "b".repeat(40),
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10 +10,2 @@",
        "+x",
        "+y",
        "@@ -40 +42,1 @@",
        "+z",
      ].join("\n"),
    );
    expect(parseGitLogHunks(raw)[0]!.files[0]!.ranges).toEqual([
      [10, 11],
      [42, 42],
    ]);
  });

  it("handles a new file, whose old side is /dev/null", () => {
    const raw = record(
      "c".repeat(40),
      ["diff --git a/new.ts b/new.ts", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"),
    );
    expect(parseGitLogHunks(raw)[0]!.files[0]!.ranges).toEqual([[1, 2]]);
  });

  it("records a pure deletion as a zero-width range at the deletion point", () => {
    // `+0,0` means nothing exists there afterwards. Dropping it would lose the fact that the
    // commit touched the file at all; inventing a span would attribute it to whatever moved in.
    const raw = record(
      "d".repeat(40),
      ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -5,2 +4,0 @@", "-gone", "-also"].join("\n"),
    );
    const ranges = parseGitLogHunks(raw)[0]!.files[0]!.ranges;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]![0]).toBe(4);
  });

  it("carries the author identity through, so attribution can name a person", () => {
    const raw = record("e".repeat(40), ["diff --git a/a.ts b/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "+x"].join("\n"));
    expect(parseGitLogHunks(raw)[0]!.email).toBe("ada@x.example");
  });

  it("uses the same format template the log pass emits", () => {
    // A parser that agrees with a format string nobody uses is a parser for nothing.
    expect(GIT_LOG_FORMAT).toContain("%ae");
  });
});

describe("symbol attribution", () => {
  const spans: SymbolSpan[] = [
    { id: "a.ts#alpha@1", file: "a.ts", line: 1, endLine: 10 },
    { id: "a.ts#beta@20", file: "a.ts", line: 20, endLine: 30 },
  ];

  const hunk = (author: string, email: string, ranges: ReadonlyArray<readonly [number, number]>) => ({
    sha: "f".repeat(40),
    author,
    email,
    at: ago(3),
    files: [{ path: "a.ts", ranges }],
  });

  it("attributes a commit to the symbol whose span the change intersects", () => {
    const out = symbolOwnership([hunk("Ada", "ada@x.example", [[3, 4]])], spans);
    expect(out.symbols.map((s) => s.symbolId)).toEqual(["a.ts#alpha@1"]);
  });

  it("does not attribute a change that falls between two symbols", () => {
    // Line 15 is in neither span — an import edit, say. Attributing it to the nearest symbol
    // would be a confident wrong answer.
    expect(symbolOwnership([hunk("Ada", "ada@x.example", [[15, 15]])], spans).symbols).toHaveLength(0);
  });

  it("splits a symbol between two authors who both changed it", () => {
    const out = symbolOwnership(
      [
        hunk("Ada", "ada@x.example", [[22, 22]]),
        hunk("Ada", "ada@x.example", [[23, 23]]),
        hunk("Bob", "bob@x.example", [[24, 24]]),
      ],
      spans,
    );
    const beta = out.symbols.find((s) => s.symbolId === "a.ts#beta@20")!;
    expect(beta.owners[0]!.author).toBe("Ada");
    expect(beta.owners[0]!.share).toBeCloseTo(2 / 3, 5);
    expect(beta.owners[1]!.share).toBeCloseTo(1 / 3, 5);
  });

  it("attributes one commit spanning two symbols to both", () => {
    const out = symbolOwnership([hunk("Ada", "ada@x.example", [[3, 3], [25, 25]])], spans);
    expect(out.symbols.map((s) => s.symbolId).sort()).toEqual(["a.ts#alpha@1", "a.ts#beta@20"]);
  });

  it("ignores a change to a file the graph has no symbols for", () => {
    const out = symbolOwnership(
      [{ sha: "0".repeat(40), author: "Ada", email: "ada@x.example", at: ago(3), files: [{ path: "other.ts", ranges: [[1, 5]] }] }],
      spans,
    );
    expect(out.symbols).toHaveLength(0);
    expect(out.attributedCommits).toBe(0);
  });
});

describe("assembled report", () => {
  it("reports an empty history as empty rather than throwing", () => {
    // A shallow clone and a fresh `git init` both land here, and both must produce a report
    // the UI can render as "we looked and found nothing".
    const report = ownershipReport([], { windowDays: 180, now: NOW });
    expect(report.authors).toHaveLength(0);
    expect(report.files).toHaveLength(0);
    expect(report.commitsAnalysed).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it("marks itself truncated when the file cap drops data", () => {
    // Silently returning the first N files would make a partial report look complete.
    const many = Array.from({ length: 30 }, (_, i) =>
      commit({ at: ago(i + 1), files: [`f${i}.ts`] }),
    );
    const report = ownershipReport(many, { windowDays: 180, now: NOW, maxFiles: 5 });
    expect(report.files).toHaveLength(5);
    expect(report.truncated).toBe(true);
  });
});

describe("paths are rebased onto the analysed root", () => {
  /**
   * `git log` reports paths relative to the REPOSITORY root, whatever directory it runs in.
   * Everything downstream — the symbol graph, the viz nodes, the findings — is keyed relative
   * to the ANALYSED root. Index a subdirectory and the two never met: ownership entries came
   * back as `apps/web/src/x.ts` while every symbol was `src/x.ts`, so file lookups missed and
   * symbol attribution intersected nothing.
   *
   * Measured on this repository before the fix: 2,639 owned files, ZERO attributed symbols.
   * Both halves are pinned here because they failed for the same reason and could regress
   * independently.
   */
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repoWithSubdir(): string {
    const root = mkdtempSync(path.join(tmpdir(), "cg-own-sub-"));
    dirs.push(root);
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    };
    run("init", "-q");
    run("config", "user.email", "ada@example.com");
    run("config", "user.name", "Ada");
    mkdirSync(path.join(root, "pkg", "src"), { recursive: true });
    writeFileSync(path.join(root, "outside.ts"), "export const out = 1;\n");
    writeFileSync(
      path.join(root, "pkg", "src", "a.ts"),
      "export function alpha() {\n  return 1;\n}\n",
    );
    run("add", "-A");
    run("commit", "-qm", "initial");
    return root;
  }

  it("keys ownership on paths relative to the analysed subdirectory", () => {
    const root = repoWithSubdir();
    const report = gitOwnership(path.join(root, "pkg"));
    const paths = report.files.map((f) => f.path);
    expect(paths).toContain("src/a.ts");
    expect(paths.some((p) => p.startsWith("pkg/"))).toBe(false);
  });

  it("excludes files outside the analysed subdirectory", () => {
    // A commit that also touched a sibling directory did not touch THIS tree there, and
    // counting it would attribute edits to files the index has never seen.
    const root = repoWithSubdir();
    expect(gitOwnership(path.join(root, "pkg")).files.map((f) => f.path)).not.toContain("outside.ts");
  });

  it("attributes symbols in a subdirectory index", () => {
    // The half that was silently zero. Spans are keyed the same way the symbol graph keys them.
    const root = repoWithSubdir();
    const report = gitOwnership(path.join(root, "pkg"), {
      symbols: [{ id: "src/a.ts#alpha@1", file: "src/a.ts", line: 1, endLine: 3 }],
    });
    expect(report.symbols.map((s) => s.symbolId)).toEqual(["src/a.ts#alpha@1"]);
  });

  it("still works when the analysed root IS the repository root", () => {
    // The prefix is empty there, so the rebase must be the identity rather than a no-op that
    // accidentally filters everything out.
    const root = repoWithSubdir();
    const paths = gitOwnership(root).files.map((f) => f.path);
    expect(paths).toContain("outside.ts");
    expect(paths).toContain("pkg/src/a.ts");
  });

  it("fetches only the subtree's diffs, so a monorepo does not overflow the buffer", () => {
    /**
     * `git log` run inside a subdirectory still walks the WHOLE repository unless a pathspec
     * narrows it. On this repository that meant 200 commits of full `-p -U0` output, which blew
     * the 32 MiB buffer; `execFileSync` threw ENOBUFS and the caller turned that into "no
     * symbol attribution" — so the feature silently never worked on exactly the repositories
     * big enough to want it.
     *
     * Asserted on the payload rather than on the attribution, because a small fixture cannot
     * reproduce the overflow: what is checkable is that the out-of-scope file is not in the
     * bytes we asked git for.
     */
    const root = repoWithSubdir();
    const scoped = gitHunkLog(path.join(root, "pkg"), { since: "30.days.ago" });
    expect(scoped).toContain("src/a.ts");
    expect(scoped).not.toContain("outside.ts");

    // The control: from the repository root the same call DOES see it, so the assertion above
    // is about the pathspec and not about the fixture happening to omit the file.
    expect(gitHunkLog(root, { since: "30.days.ago" })).toContain("outside.ts");
  });
});
