import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md §5: "Don't claim in the README what the code doesn't do. Every claim should map to a
 * passing test. This project's credibility is its main asset."
 *
 * WHY THIS FILE EXISTS. Four README claims had silently gone stale:
 *
 *   · "jobs run fire-and-forget in the same Node process (no external queue)" — P2 moved
 *     analysis into `apps/worker` with a SQLite queue, and the shipped image sets
 *     CG_USE_WORKER=true. The README described the architecture the postmortem replaced.
 *   · "Health Score 77" and "77 → 82" — moved to 74 and 74 → 81 when the pillars were split.
 *   · "P0:21 · P1:38 · P2:0 · P3:0 … the empty P2/P3 buckets are a judge-calibration issue" —
 *     now P0:8 · P1:16 · P2:35. The calibration was fixed; the README kept the complaint.
 *   · "479/479 across 34 files" — now 770 across 59.
 *
 * These tests check claims that can be checked WITHOUT a network clone. The numeric benchmarks
 * are re-derived by `npm run bench`, which the README cites as their source — a test that
 * silently skips without a clone would be the same false comfort as the stale numbers.
 */

const root = path.join(process.cwd());
const README = readFileSync(path.join(root, "README.md"), "utf8");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("architecture claims match the code", () => {
  it("does not claim analysis runs inline in the web process", () => {
    // The exact phrasing that was wrong. Kept as a negative assertion because the sentence was
    // literally true once, which is how it survived review.
    expect(README).not.toMatch(/jobs run fire-and-forget in the same Node process/);
    expect(README).not.toMatch(/no external queue/);
  });

  it("claims a worker process, and one exists", () => {
    expect(README).toMatch(/separate `apps\/worker` process/);
    expect(() => read("apps/worker/src/main.ts")).not.toThrow();
  });

  it("claims the shipped image enables the worker, and the Dockerfile does", () => {
    expect(README).toMatch(/CG_USE_WORKER=true/);
    expect(read("Dockerfile")).toMatch(/ENV CG_USE_WORKER=true/);
  });
});

describe("Health Score claims match the model", () => {
  it("describes the headline as defect risk, not a blend", () => {
    // The pillar split (P4 §5.1) changed what the number means, not just its value.
    expect(README).toMatch(/defect risk/i);
    expect(README).toMatch(/never averaged in/);
  });

  it("says the score reports its own coverage, and it does", () => {
    expect(README).toMatch(/coverage it was computed over/);
    // ADR-008's rendering lives here.
    expect(read("apps/web/src/app/repos/[id]/page.tsx")).toMatch(/Scored over/);
  });
});

describe("CLI claims match the CLI", () => {
  it("documents `codegraph fix` and the command exists", () => {
    expect(README).toMatch(/codegraph fix/);
    expect(() => read("apps/cli/src/fix.ts")).not.toThrow();
  });

  it("documents the flags the parser actually accepts", () => {
    const main = read("apps/cli/src/main.ts");
    for (const flag of ["--verify", "--rule", "--file", "--json"]) {
      expect(README, `README should document ${flag}`).toContain(flag);
      expect(main, `CLI should accept ${flag}`).toContain(`"${flag}"`);
    }
  });

  it("claims the source is never modified, and the CLI works on a copy", () => {
    expect(README).toMatch(/source is never modified/i);
    expect(read("apps/cli/src/fix.ts")).toMatch(/mkdtempSync/);
  });
});

describe("benchmark numbers are reproducible, not asserted", () => {
  it("cites `npm run bench` as the source for every express row", () => {
    // Each benchmark row must point at something re-runnable. The rows previously pointed at
    // prose documents, which is how three of their numbers drifted unnoticed.
    // Table rows only — the prose above the table also names the pinned commit.
    const rows = README.split("\n").filter(
      (l) => l.startsWith("|") && l.includes("expressjs/express@a371447"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row).toMatch(/npm run bench/);
  });

  it("ships the bench script the README points at", () => {
    expect(() => read("scripts/bench.mts")).not.toThrow();
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.bench).toBe("tsx scripts/bench.mts");
  });

  it("pins the benchmark to the commit the README names", () => {
    // A moving target is not a benchmark.
    expect(read("scripts/bench.mts")).toMatch(/const COMMIT = "a371447"/);
  });
});

describe("feature status is stated", () => {
  it("labels every area the plan requires a label for", () => {
    // PLAN.md P7: status labels on Fleet, Timeline, CLI. `Desktop` was in this list until
    // apps/desktop was removed — the README must not carry a status for a shipped surface
    // that is gone, so the label is asserted absent instead.
    for (const area of ["CLI", "Fleet", "Timeline"]) {
      expect(README).toContain(area);
    }
    expect(README).not.toMatch(/Desktop \(Electron\)/);
    expect(README).toMatch(/\*\*stable\*\*/);
    expect(README).toMatch(/\*\*beta\*\*/);
    expect(README).toMatch(/\*\*experimental\*\*/);
  });

  it("does not describe the CLI as more than one command", () => {
    // Honest scope: `codegraph index` and `codegraph score` do not exist.
    expect(README).toMatch(/`index` and `score` do not exist yet/);
    const main = read("apps/cli/src/main.ts");
    expect(main).not.toMatch(/case "index"|command === "index"/);
  });
});

describe("the test-suite claim counts what exists", () => {
  /**
   * The precise CASE count is deliberately not asserted: it changes on almost every commit, and
   * a number that must be bumped constantly is one people learn to bump without checking. It is
   * published with a date instead.
   *
   * The FILE counts are exact and cheap, so they are enforced. This row went stale twice —
   * "479/479 across 34 files" survived the whole monorepo migration, and "770 across 59" was
   * stale within the same session that wrote it, because adding these very tests moved it.
   */
  const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".next", "test-results"]);
  const countTestFiles = (dirs: string[]): number => {
    const { readdirSync, existsSync, statSync } = require("node:fs") as typeof import("node:fs");
    let n = 0;
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // Build OUTPUT contains copies of test files — `apps/desktop/build/standalone`
          // carries the whole of `apps/web/tests`. Walking it made this assertion depend on
          // whether the machine had run a build: green on CI (which builds desktop and web in
          // separate checkouts) and red for any developer who built both. Counting sources
          // means counting sources.
          if (!SKIP_DIRS.has(e.name)) walk(full);
        } else if (e.name.endsWith(".test.ts")) n++;
      }
    };
    for (const d of dirs) walk(path.join(root, d));
    return n;
  };

  it("claims the number of workspace test files that exist", () => {
    const claimed = Number(README.match(/\*\*(\d+) test files\*\* in the workspace/)?.[1]);
    const actual = countTestFiles([
      "apps/cli/tests", "apps/web/tests", "apps/worker/tests", "packages",
    ]);
    expect(claimed).toBe(actual);
  });

  // The Electron file-count assertion lived here. It went with apps/desktop: a claim about a
  // workspace that no longer exists is not a weaker test, it is a test of nothing.
});

describe("the deploy's two dockerfile paths both resolve", () => {
  /**
   * Render's build reads the file named by the service's `Dockerfile Path`, then asks BuildKit
   * to build a dockerfile called `Dockerfile` FROM THE CONTEXT ROOT. That is two lookups, and
   * a deploy needs both to land. Evidence for the shape, from two real failures:
   *
   *   · with the dockerfile at `apps/web/Dockerfile`, the log read
   *     `transferring dockerfile: 7.49kB` — exactly that file's size — and then failed with
   *     `open Dockerfile : no such file or directory`. So the READ used the configured path
   *     while the BUILD used the bare name. Had it passed `-f apps/web/Dockerfile`, the error
   *     would have named that path.
   *   · after the file moved to the repo root, the same deploy read
   *     `transferring dockerfile: 2B` — reproduced locally as a context with no dockerfile at
   *     all — because the configured path no longer existed.
   *
   * So both paths have to hold the same real build definition, and this is the cheapest
   * possible guard on that. Delete this test and `apps/web/Dockerfile` together, once the
   * service's Dockerfile Path is `./Dockerfile` and a deploy has proven it.
   *
   * A SYMLINK was tried first and rejected on evidence: BuildKit refuses to build through one
   * (`docker build -f apps/web/Dockerfile .` → `failed to read dockerfile: too many links`).
   * It satisfies the read but breaks the one invocation the read-then-build theory says Render
   * does not use — and after this many failed deploys, "works under my theory" is not the bar.
   * A duplicate works under either, so the duplicate ships and this test is what makes it safe.
   */
  const { readFileSync } = require("node:fs") as typeof import("node:fs");

  it("has the real build definition at the context root, where BuildKit looks for it", () => {
    // The invariant the ORIGINAL working config had (`./app/Dockerfile` + context `./app`) and
    // that the P1 monorepo move broke by leaving the dockerfile at `apps/web/Dockerfile` while
    // the context became the repo root.
    const rootDockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(rootDockerfile).toMatch(/ENV CG_USE_WORKER=true/);
  });

  it("carries no `# syntax=` directive, so no external frontend re-reads the dockerfile", () => {
    // This assertion was written the other way round — requiring the directive — and this
    // suite failed the moment it was removed. Kept, inverted, because the removal is the fix
    // for the fifth failed deploy and nothing in the file's content would reveal that:
    //
    //   #1 [internal] load build definition from Dockerfile
    //   #1 transferring dockerfile: 9.55kB done      <- read correctly, right size
    //   #1 DONE 0.0s
    //   error: failed to solve: failed to read dockerfile: open Dockerfile : no such file
    //
    // `# syntax=` hands the build to an EXTERNAL frontend image which resolves the dockerfile
    // itself instead of using the definition BuildKit already loaded, and on Render that
    // second resolution failed. The directive bought this file nothing: no `RUN --mount`, no
    // heredocs, no `COPY --link`, no `COPY --chmod`. Adding it back means re-introducing the
    // failure, so it fails here first.
    const rootDockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(rootDockerfile).not.toMatch(/^#\s*syntax\s*=/m);
    // ...and the features that would justify bringing it back are absent, so the removal
    // stays safe. Comment lines are stripped first: the header above NAMES those features in
    // prose, and the first version of this assertion matched its own explanation.
    const instructions = rootDockerfile
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(instructions).not.toMatch(/RUN\s+--mount|COPY\s+--link|COPY\s+--chmod|<<[A-Z]/);
  });

  it("keeps apps/web/Dockerfile byte-identical to it", () => {
    // THE failure mode of a duplicate is drift: two build definitions, one of them edited, and
    // a deploy built from whichever the platform happened to read. Byte equality is the whole
    // safety argument for shipping a copy at all, so it is enforced rather than intended.
    // Edit the root file; `cp Dockerfile apps/web/Dockerfile` until the link can be deleted.
    expect(readFileSync(path.join(root, "apps/web/Dockerfile"), "utf8")).toBe(
      readFileSync(path.join(root, "Dockerfile"), "utf8"),
    );
  });
});

describe("ARCHITECTURE.md describes the architecture that exists", () => {
  /**
   * Review C6. The document CONTRADICTED ITSELF before this: the Stack table said "no
   * queue/orchestrator/message bus" and the request flow said "jobs are fire-and-forget within
   * the same Node process … there's no external queue", while the Known-constraints section
   * three paragraphs later correctly described `apps/worker` spawning a child process per job.
   *
   * That is what a stale doc looks like in practice — not wholly wrong, but updated in the one
   * place someone happened to be editing.
   */
  const ARCH = read("ARCHITECTURE.md");

  it("does not still claim there is no queue", () => {
    expect(ARCH).not.toMatch(/no queue\/orchestrator\/message bus/);
    expect(ARCH).not.toMatch(/there's no external queue/);
    expect(ARCH).not.toMatch(/fire-and-forget within the same Node process/);
  });

  it("states the real route count", () => {
    const claimed = Number(ARCH.match(/←\s*(\d+) routes/)?.[1]);
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    let actual = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "route.ts") actual++;
      }
    };
    walk(path.join(root, "apps/web/src/app/api"));
    expect(claimed).toBe(actual);
  });

  it("lists every package that exists, in the package TABLE", () => {
    // A package table is only useful if it is complete — an omitted one is a boundary nobody
    // reading this doc knows about.
    //
    // Scoped to table rows, not the whole document. The first version used
    // `expect(ARCH).toContain(pkg)` and a mutation deleting the `sandbox` row still passed,
    // because "sandbox" also appears in the security section's "sandboxed fixer". A test that
    // matches prose proves nothing about the table.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const onDisk = readdirSync(path.join(root, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    // Every backticked name in the row's FIRST cell — some rows legitimately group packages
    // that are split together later (`analysis` · `analysis-model` · `core-graph`, LLD §13).
    const tableCells = ARCH.split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!));

    for (const pkg of onDisk) {
      expect(tableCells, `ARCHITECTURE.md's package table should list ${pkg}`).toContain(pkg);
    }
  });

  it("names both dispatch paths and the flag that selects them", () => {
    expect(ARCH).toMatch(/CG_USE_WORKER/);
    expect(ARCH).toMatch(/void runJob/);
    // And the flag it names must be real.
    expect(read("apps/web/src/lib/store.ts")).toMatch(/config\.useWorker/);
  });

  it("warns that the old lib paths are re-export shims", () => {
    // `apps/web/src/lib/indexer.ts` still exists but is three lines of re-export; a reader
    // following the old diagram would look for the pipeline there and find nothing.
    expect(ARCH).toMatch(/re-export shims/);
    expect(read("apps/web/src/lib/indexer.ts")).toMatch(/Re-export shim/);
  });

  it("does not claim a budget gate that no longer exists", () => {
    // Verified: zero config entries read CG_TREE_SITTER_MAX_RSS_BYTES; the only occurrence in
    // the codebase is a comment in apps/worker/src/supervise.ts explaining its absence.
    expect(read("packages/config/src/definition.ts")).not.toMatch(/TREE_SITTER/);
    expect(ARCH).toMatch(/budget gate is gone|no longer exists in the code/);
  });
});
