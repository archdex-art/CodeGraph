import { describe, expect, it } from "vitest";
import { isBotAuthor, isFixSubject, parseGitLog, signalsFromCommits, type FileSignals } from "../src/signals";

/**
 * PLAN.md §5.2's organisational signals.
 *
 * Tested through `signalsFromCommits`, which is pure, rather than through `gitSignals`, which
 * shells out. This repository has a SINGLE author, so every author-derived signal is degenerate
 * against its own history — `authors: 1, ownershipRatio: 1, changeEntropy: 0` for all 2505
 * files. Validating them needed history this repo cannot provide, so the fixtures below supply
 * it explicitly.
 */

const RS = "\x1e";
const US = "\x1f";

/** Build a raw `git log` payload in exactly the format `gitSignals` requests. */
const log = (
  commits: Array<{ author: string; at: number; subject: string; files: string[] }>,
): string =>
  commits
    .map((c) => `${RS}deadbeef${US}${c.author}${US}${c.at}${US}${c.subject}\n${c.files.join("\n")}\n`)
    .join("");

const DAY = 86_400;
const sig = (raw: string): Map<string, FileSignals> => signalsFromCommits(parseGitLog(raw));

describe("parseGitLog", () => {
  it("reads author, timestamp, subject and files", () => {
    const c = parseGitLog(log([{ author: "Ada", at: 1000, subject: "add thing", files: ["a.ts"] }]));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ author: "Ada", at: 1000, files: ["a.ts"] });
  });

  it("survives an empty log", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  it("survives a commit that touched no files", () => {
    // An empty commit, or a merge — git emits the header and no file list.
    expect(parseGitLog(`${RS}h${US}Ada${US}1${US}subject\n`)[0]!.files).toEqual([]);
  });

  it("does not split an author name containing spaces or punctuation", () => {
    const c = parseGitLog(log([{ author: "Ada L. Byron", at: 1, subject: "x", files: ["a.ts"] }]));
    expect(c[0]!.author).toBe("Ada L. Byron");
  });
});

describe("ownership and congestion", () => {
  it("reports one owner for a file only one person touches", () => {
    const s = sig(
      log([
        { author: "Ada", at: DAY, subject: "a", files: ["a.ts"] },
        { author: "Ada", at: 2 * DAY, subject: "b", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.authors).toBe(1);
    expect(s.ownershipRatio).toBe(1);
    expect(s.busFactor).toBe(1);
    expect(s.changeEntropy).toBe(0);
  });

  it("drops ownership and raises congestion as more hands touch a file", () => {
    const s = sig(
      log([
        { author: "Ada", at: DAY, subject: "a", files: ["a.ts"] },
        { author: "Bob", at: 2 * DAY, subject: "b", files: ["a.ts"] },
        { author: "Cy", at: 3 * DAY, subject: "c", files: ["a.ts"] },
        { author: "Dee", at: 4 * DAY, subject: "d", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.authors).toBe(4);
    expect(s.ownershipRatio).toBe(0.25);
    // Four equal contributors: entropy is maximal, so normalised to 1.
    expect(s.changeEntropy).toBeCloseTo(1, 10);
  });

  it("computes bus factor as the fewest authors covering half the edits", () => {
    // Ada 6, Bob 1, Cy 1, Dee 1, Eve 1 -> Ada alone is 6/10, so 1.
    const s = sig(
      log([
        ...Array.from({ length: 6 }, (_, i) => ({ author: "Ada", at: (i + 1) * DAY, subject: "x", files: ["a.ts"] })),
        { author: "Bob", at: 7 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Cy", at: 8 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Dee", at: 9 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Eve", at: 10 * DAY, subject: "x", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.authors).toBe(5);
    expect(s.busFactor).toBe(1);
    expect(s.ownershipRatio).toBeCloseTo(0.6, 10);
  });

  it("needs more authors for the bus factor when work is spread evenly", () => {
    const s = sig(
      log(
        ["Ada", "Bob", "Cy", "Dee"].map((author, i) => ({
          author,
          at: (i + 1) * DAY,
          subject: "x",
          files: ["a.ts"],
        })),
      ),
    ).get("a.ts")!;
    // Four equal authors: two of them reach exactly half.
    expect(s.busFactor).toBe(2);
  });
});

describe("knowledge loss", () => {
  it("counts edits from authors absent in the recent third of the window", () => {
    // Window days 1-30. Recent third begins day ~20. Ada leaves after day 3, Bob stays.
    const s = sig(
      log([
        { author: "Ada", at: 1 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Ada", at: 3 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Bob", at: 25 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Bob", at: 30 * DAY, subject: "x", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.knowledgeLoss).toBeCloseTo(0.5, 10);
  });

  it("is zero when everyone is still active", () => {
    // Both inside the recent third of a 30-day window.
    const s = sig(
      log([
        { author: "Ada", at: 25 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Bob", at: 30 * DAY, subject: "x", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.knowledgeLoss).toBe(0);
  });

  it("refuses to judge departure over a short history", () => {
    // A two-day span makes the "recent third" sixteen hours, so a colleague who committed
    // yesterday would read as departed. Below 14 days the signal reports 0 rather than a
    // number it cannot support.
    const s = sig(
      log([
        { author: "Ada", at: 1 * DAY, subject: "x", files: ["a.ts"] },
        { author: "Bob", at: 3 * DAY, subject: "x", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.knowledgeLoss).toBe(0);
  });
});

describe("co-change scatter", () => {
  it("counts distinct other files changed alongside", () => {
    const s = sig(
      log([
        { author: "Ada", at: DAY, subject: "x", files: ["a.ts", "b.ts"] },
        { author: "Ada", at: 2 * DAY, subject: "x", files: ["a.ts", "c.ts"] },
        { author: "Ada", at: 3 * DAY, subject: "x", files: ["a.ts", "b.ts"] },
      ]),
    ).get("a.ts")!;
    // b twice and c once = two DISTINCT partners, not three co-change events.
    expect(s.coChangeScatter).toBe(2);
  });

  it("ignores sweeping commits so a reformat does not read as coupling", () => {
    // 60 files in one commit is a rename or a reformat, above the 50-file cap.
    const wide = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const s = sig(log([{ author: "Ada", at: DAY, subject: "reformat", files: wide }])).get("f0.ts")!;
    expect(s.coChangeScatter).toBe(0);
    // It still counts as churn — the file did change.
    expect(s.churn).toBe(1);
  });
});

describe("prior defect", () => {
  it.each([
    ["fix: null deref", 1],
    ["Fixes #42", 1],
    ["revert bad commit", 1],
    ["hotfix login", 1],
    // WAS `1`. The hand-audit against real express history disproved it: `closes`/`resolves`
    // shut an issue of ANY kind, and three of twenty sampled "defects" were a feature, a
    // refactor and a chore that happened to close a ticket. Only `fixes #N` survives.
    ["closes #7", 0],
    ["fixes #7", 1],
    ["add a feature", 0],
    ["refactor the parser", 0],
    ["docs: update readme", 0],
  ])("classifies %s", (subject, expected) => {
    const s = sig(log([{ author: "Ada", at: DAY, subject, files: ["a.ts"] }])).get("a.ts")!;
    expect(s.priorDefect).toBe(expected);
  });
});

describe("age volatility", () => {
  it("is zero for evenly spaced changes", () => {
    const s = sig(
      log(
        [1, 2, 3, 4, 5].map((d) => ({ author: "Ada", at: d * DAY, subject: "x", files: ["a.ts"] })),
      ),
    ).get("a.ts")!;
    expect(s.ageVolatility).toBe(0);
  });

  it("rises when changes arrive in a burst", () => {
    const even = sig(
      log([10, 20, 30, 40].map((d) => ({ author: "Ada", at: d * DAY, subject: "x", files: ["a.ts"] }))),
    ).get("a.ts")!;
    const bursty = sig(
      log([1, 2, 3, 300].map((d) => ({ author: "Ada", at: d * DAY, subject: "x", files: ["a.ts"] }))),
    ).get("a.ts")!;
    expect(bursty.ageVolatility).toBeGreaterThan(even.ageVolatility);
  });

  it("is zero rather than misleading with too few changes", () => {
    // Two timestamps give exactly one gap, whose variation is undefined.
    const s = sig(
      log([
        { author: "Ada", at: DAY, subject: "x", files: ["a.ts"] },
        { author: "Ada", at: 90 * DAY, subject: "x", files: ["a.ts"] },
      ]),
    ).get("a.ts")!;
    expect(s.ageVolatility).toBe(0);
  });
});

describe("degenerate input", () => {
  it("returns an empty map for no commits", () => {
    expect(signalsFromCommits([]).size).toBe(0);
  });
});

describe("isFixSubject — the label classifier", () => {
  /**
   * Every case below was found by auditing real `expressjs/express` history (6158 commits),
   * not invented. The classifier went 1140 flagged (18.5%) -> 565 (9.2%) across two rounds of
   * audit, and precision on a 20-commit sample went from ~85% to ~95%.
   */
  it.each([
    ["fix(res.send): add Content-Length header only if Transfer-Encoding is present", true],
    ["Fix res.sendFile not always detecting aborted connection", true],
    ["fixes #1826: res.redirect('toString') fails with 500", true],
    ["Revert \"Only unshift support libs once\"", true],
    ["router: fix optimization on router exit", true],
    ["hotfix: broken release", true],
  ])("flags %s", (subject, expected) => {
    expect(isFixSubject(subject)).toBe(expected);
  });

  it.each([
    // A BARE issue reference is not a fix. GitHub squash-merges append `(#123)` to EVERY
    // commit; matching it flagged 282 of 1140 express commits, almost none of them fixes.
    ["feat: allow conditional revalidation for QUERY requests (#7366)", false],
    ["docs: use the new logo (#7316)", false],
    ["build(deps): bump actions/checkout from 6.0.2 to 7.0.0 (#7345)", false],
    ["build(deps-dev): bump hbs from 4.2.0 to 4.2.1 (#7152)", false],
    ["deps: bump qs minimum to 6.15.2 (#7305)", false],
    // `closes`/`resolves` shut an issue of ANY kind. All three of these are real express
    // commits the audit caught being mislabelled as defects.
    ["Added `app.routes.all()`. Closes #803", false],
    ["Refactored router. Closes #639", false],
    ["Updated express(1). Closes #365", false],
    ["add res.vary(). Closes #1682", false],
    // Conventional type is authoritative over any keyword that follows.
    ["chore: remove the fix workaround", false],
    ["test: add coverage for the fixed path", false],
    ["perf: faster than the fix in 4.x", false],
  ])("does NOT flag %s", (subject, expected) => {
    expect(isFixSubject(subject)).toBe(expected);
  });

  it("is not fooled by words containing 'fix'", () => {
    expect(isFixSubject("add prefix handling to the router")).toBe(false);
    expect(isFixSubject("support suffix matching")).toBe(false);
  });

  it("still uses keywords when the type prefix is unrecognised", () => {
    // `router:` is not a conventional type, so the keyword path must still run.
    expect(isFixSubject("router: fix optimization on router exit")).toBe(true);
  });
});

describe("isBotAuthor", () => {
  it.each(["dependabot[bot]", "renovate[bot]", "github-actions[bot]", "snyk-bot"])(
    "recognises %s",
    (name) => expect(isBotAuthor(name)).toBe(true),
  );

  it.each(["Tj Holowaychuk", "Douglas Christopher Wilson", "Robot Ada"])(
    "does not misclassify %s",
    (name) => expect(isBotAuthor(name)).toBe(false),
  );

  it("keeps bot commits out of the author signals entirely", () => {
    // `authors`, `busFactor` and `changeEntropy` measure how many HUMANS touch a file. A bot
    // with hundreds of dependency bumps otherwise reads as the most involved contributor.
    const withBot = sig(
      log([
        { author: "Ada", at: DAY, subject: "x", files: ["a.ts"] },
        ...Array.from({ length: 20 }, (_, i) => ({
          author: "dependabot[bot]",
          at: (i + 2) * DAY,
          subject: "build(deps): bump x",
          files: ["a.ts"],
        })),
      ]),
    ).get("a.ts")!;
    expect(withBot.authors).toBe(1);
    expect(withBot.churn).toBe(1);
    expect(withBot.ownershipRatio).toBe(1);
  });
});
