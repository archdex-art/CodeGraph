import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "@codegraph/core-graph";
import { parseUnifiedDiff, statusFromNameStatus } from "@/lib/printel/diff";
import { analysePr } from "@/lib/printel/analyse";
import type { Commit } from "@codegraph/vcs";
import type { SymbolGraph } from "@/lib/types";

/**
 * PR intelligence over a real diff and a real symbol graph.
 *
 * The graph is built from fixture sources with `buildSymbolGraph`, not hand-assembled, so the
 * call edges these assertions rely on are the ones the extractor actually produces. A
 * hand-built graph would test the joining logic against a shape the extractor never emits.
 */

const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

const NOW = 1_700_000_000;
const DAY = 86_400;
const ago = (days: number): number => NOW - days * DAY;

function commit(author: string, at: number, files: readonly string[]): Commit {
  return { author, email: `${author.toLowerCase()}@x.example`, at, isFix: false, sha: "0".repeat(40), subject: "c", files };
}

/** `git diff --unified=0` output for one file with one hunk. */
const hunk = (path: string, start: number, count: number): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start} +${start},${count} @@`,
    ...Array.from({ length: count }, () => "+x"),
  ].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads the post-image range of a modified file", () => {
    const [file] = parseUnifiedDiff(hunk("src/a.ts", 10, 3));
    expect(file!.path).toBe("src/a.ts");
    expect(file!.status).toBe("modified");
    expect(file!.ranges).toEqual([[10, 12]]);
  });

  it("keeps every hunk in a multi-hunk file", () => {
    const raw = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10 +10,2 @@",
      "+x",
      "+y",
      "@@ -40 +42,1 @@",
      "+z",
    ].join("\n");
    expect(parseUnifiedDiff(raw)[0]!.ranges).toEqual([
      [10, 11],
      [42, 42],
    ]);
  });

  it("marks a new file added, with its whole body as the range", () => {
    const raw = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ].join("\n");
    const [file] = parseUnifiedDiff(raw);
    expect(file!.status).toBe("added");
    expect(file!.ranges).toEqual([[1, 2]]);
  });

  it("marks a removed file deleted and gives it no post-image range", () => {
    // There is no post-image to name lines in. Inventing one would attribute the deletion to
    // whatever now occupies those lines in the current tree.
    const raw = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-a",
      "-b",
      "-c",
    ].join("\n");
    const [file] = parseUnifiedDiff(raw);
    expect(file!.status).toBe("deleted");
    expect(file!.path).toBe("gone.ts");
    expect(file!.ranges).toEqual([]);
  });

  it("reports a rename under its NEW path", () => {
    const raw = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 95%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "+x",
    ].join("\n");
    const [file] = parseUnifiedDiff(raw);
    expect(file!.status).toBe("renamed");
    expect(file!.path).toBe("new.ts");
  });

  it("reads an unknown --name-status letter as modified rather than dropping the file", () => {
    expect(statusFromNameStatus("X")).toBe("modified");
    expect(statusFromNameStatus("D")).toBe("deleted");
  });
});

/**
 * A small service graph:
 *   handler -> service -> repository (db-tagged by name)
 * plus an unrelated function and a test that calls the service.
 */
async function serviceGraph(): Promise<SymbolGraph> {
  return buildSymbolGraph(
    [
      f(
        "src/db/userRepository.ts",
        "/** Runs the SQL query that loads a user row. */\nexport function queryUser(id: string) { return { id }; }\n",
      ),
      f(
        "src/service/pay.ts",
        [
          "import { queryUser } from '../db/userRepository';",
          "export function chargeUser(id: string) { return queryUser(id); }",
          "",
        ].join("\n"),
      ),
      f(
        "src/app/api/pay/route.ts",
        [
          "import { chargeUser } from '../../../service/pay';",
          "export function POST(req: Request) { return chargeUser('1'); }",
          "",
        ].join("\n"),
      ),
      f("src/unrelated.ts", "export function untouched() { return 1; }\n"),
      f(
        "src/service/report.ts",
        [
          "import { queryUser } from '../db/userRepository';",
          "export function buildReport() { return queryUser('1'); }",
          "export function summarise() { return buildReport(); }",
          "export function exportCsv() { return summarise(); }",
          "",
        ].join("\n"),
      ),
      f(
        "tests/pay.test.ts",
        [
          "import { chargeUser } from '../src/service/pay';",
          "export function testCharge() { return chargeUser('1'); }",
          "",
        ].join("\n"),
      ),
    ],
    new Map(),
  );
}

const FILES = [
  { rel: "src/db/userRepository.ts" },
  { rel: "src/service/pay.ts" },
  { rel: "src/app/api/pay/route.ts" },
  { rel: "src/unrelated.ts" },
  { rel: "src/service/report.ts" },
  { rel: "tests/pay.test.ts", text: "import { chargeUser } from '../src/service/pay';" },
];

async function analyse(diff: string, extra?: Partial<Parameters<typeof analysePr>[0]>) {
  const graph = await serviceGraph();
  return analysePr({
    base: "main",
    head: "HEAD",
    changed: parseUnifiedDiff(diff),
    graph,
    commits: [],
    windowDays: 180,
    files: FILES,
    ...extra,
  });
}

describe("changed symbols", () => {
  it("reports the symbol whose span the change intersects", async () => {
    const a = await analyse(hunk("src/service/pay.ts", 2, 1));
    expect(a.changedSymbols.map((s) => s.name)).toContain("chargeUser");
  });

  it("does not report a symbol the change falls outside", async () => {
    // Line 1 is the import, in no function's span. Attributing it to the nearest symbol would
    // be a confident wrong answer, and it is the answer a naive file-level join gives.
    const a = await analyse(hunk("src/service/pay.ts", 1, 1));
    expect(a.changedSymbols.map((s) => s.name)).not.toContain("chargeUser");
  });

  it("attributes a deleted file's symbols by path, since it has no post-image", async () => {
    const raw = [
      "diff --git a/src/service/pay.ts b/src/service/pay.ts",
      "deleted file mode 100644",
      "--- a/src/service/pay.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
    ].join("\n");
    const a = await analyse(raw);
    const charge = a.changedSymbols.find((s) => s.name === "chargeUser");
    expect(charge).toBeDefined();
    expect(charge!.via).toBe("file-removed");
  });
});

describe("impact and reach", () => {
  it("finds transitive callers of the change", async () => {
    const a = await analyse(hunk("src/db/userRepository.ts", 2, 1));
    const names = a.dependencyImpact.map((s) => s.name);
    expect(names).toContain("chargeUser");
    expect(names).toContain("POST");
  });

  it("excludes the changed symbol from its own blast radius", async () => {
    // Leaving it in inflates every count and makes a one-function PR look self-referential.
    const a = await analyse(hunk("src/db/userRepository.ts", 2, 1));
    expect(a.dependencyImpact.map((s) => s.name)).not.toContain("queryUser");
  });

  it("does not implicate an unrelated symbol", async () => {
    const a = await analyse(hunk("src/db/userRepository.ts", 2, 1));
    expect(a.dependencyImpact.map((s) => s.name)).not.toContain("untouched");
  });

  it("reports the top-level module of every changed file", async () => {
    const a = await analyse(hunk("src/service/pay.ts", 2, 1));
    expect(a.affectedModules).toEqual(["src"]);
  });

  it("names a database-tagged symbol reached from the change", async () => {
    const a = await analyse(hunk("src/service/pay.ts", 2, 1));
    const model = a.affectedDbModels.find((m) => m.name === "queryUser");
    expect(model).toBeDefined();
    // The evidence must say WHY, not merely that it was found.
    expect(model!.evidence).toContain("chargeUser");
  });
});

describe("relevant tests", () => {
  it("finds a test that imports a changed file", async () => {
    const a = await analyse(hunk("src/service/pay.ts", 2, 1));
    const test = a.relevantTests.find((t) => t.file === "tests/pay.test.ts");
    expect(test).toBeDefined();
    expect(test!.reason).toContain("imports");
  });

  it("finds a test through a call edge when nothing in it imports the changed path", async () => {
    // The case a filename convention misses: the test imports the SERVICE, and the change is in
    // the repository two hops away. Only the call graph connects them.
    const a = await analyse(hunk("src/db/userRepository.ts", 2, 1), {
      files: [...FILES.slice(0, 4), { rel: "tests/pay.test.ts", text: "no import of the changed path here" }],
    });
    const test = a.relevantTests.find((t) => t.file === "tests/pay.test.ts");
    expect(test).toBeDefined();
    expect(test!.reason).toContain("calls changed code");
  });
});

describe("risk", () => {
  it("publishes every factor with its evidence, so the score can be argued with", async () => {
    const a = await analyse(hunk("src/db/userRepository.ts", 2, 1));
    expect(a.risk.factors.length).toBeGreaterThan(0);
    for (const factor of a.risk.factors) {
      expect(factor.evidence.length).toBeGreaterThan(0);
      expect(factor.value).toBeGreaterThanOrEqual(0);
      expect(factor.value).toBeLessThanOrEqual(1);
    }
  });

  it("scores a wider blast radius above a narrower one, all else equal", async () => {
    /**
     * The narrow change touches a leaf nothing calls; the wide one touches the symbol six
     * others reach. Test coverage is held constant by withholding the test file from BOTH, and
     * that is the point of the test rather than a convenience: an earlier version compared the
     * two with tests present, and the "wider" change scored LOWER because it was the one with
     * a relevant test. The model was right and the test was wrong — a weighted sum can only be
     * checked one term at a time.
     */
    const noTests = FILES.filter((x) => !x.rel.startsWith("tests/"));
    const narrow = await analyse(hunk("src/unrelated.ts", 1, 1), { files: noTests });
    const wide = await analyse(hunk("src/db/userRepository.ts", 2, 1), { files: noTests });

    const blastOf = (a: Awaited<ReturnType<typeof analyse>>) =>
      a.risk.factors.find((x) => x.name === "blast-radius")!.value;
    expect(blastOf(wide)).toBeGreaterThan(blastOf(narrow));
    expect(wide.risk.score).toBeGreaterThan(narrow.risk.score);
  });

  it("scores an untested change above the same change with a test", async () => {
    // Isolates the test-coverage term: identical diff, and the only difference is whether any
    // test file relates to it. Without this the term could be zero-weighted and unnoticed.
    const withTest = await analyse(hunk("src/service/pay.ts", 2, 1));
    const withoutTest = await analyse(hunk("src/service/pay.ts", 2, 1), {
      files: FILES.slice(0, 4),
    });
    expect(withoutTest.risk.score).toBeGreaterThan(withTest.risk.score);
    expect(withoutTest.risk.factors.find((x) => x.name === "test-coverage")!.value).toBe(1);
  });

  it("scores a diff that changes nothing measurable at zero", async () => {
    // No constant term: an empty change must not carry baseline risk.
    const a = await analyse("");
    expect(a.risk.score).toBe(0);
    expect(a.risk.band).toBe("low");
  });
});

describe("reviewers", () => {
  it("recommends the owner of a changed file from real history", async () => {
    const a = await analyse(hunk("src/service/pay.ts", 2, 1), {
      commits: [
        commit("Ada", ago(4), ["src/service/pay.ts"]),
        commit("Ada", ago(5), ["src/service/pay.ts"]),
        commit("Bob", ago(6), ["src/unrelated.ts"]),
      ],
    });
    expect(a.reviewers[0]?.author).toBe("Ada");
  });

  it("returns no reviewers rather than a guess when there is no history", async () => {
    // A shallow clone has none. Inventing a name from the file path would be a fabricated
    // recommendation, which is worse than an empty list.
    const a = await analyse(hunk("src/service/pay.ts", 2, 1), { commits: [] });
    expect(a.reviewers).toEqual([]);
  });
});
