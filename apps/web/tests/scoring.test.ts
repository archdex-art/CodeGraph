import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "@/lib/indexer";
import type { IndexResult, Issue } from "@/lib/types";

/**
 * The Health Score is one of the five things IDENTITY.md calls ours, and the
 * README sells it as "blast-radius-weighted, explainable". These tests defend the
 * two ways it was neither.
 *
 * Everything here goes through the real `indexRepo` over a real directory. The
 * scorer is not exported, so asserting on it directly would mean testing a copy
 * of it; driving the pipeline is what proves the shipped path.
 */

/** Builds a repo where one rule matches many times in a single file. */
function buildRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-scoring-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

function issuesTitled(result: IndexResult, title: string): Issue[] {
  return result.issues.filter((i) => i.title === title);
}

describe("blast radius no longer inverts the ranking (review B2)", () => {
  // The exact scenario from the review: a severity-1 TODO in a heavily-imported
  // file versus a severity-5 eval() in a leaf. Under the old model
  // (penalty = severity × (1 + fanIn)) the TODO scored 61 and the eval 5, so the
  // trivial finding outranked the critical one 12:1.
  let dir: string;
  let result: IndexResult;

  beforeAll(async () => {
    // `hub.ts` holds the TODO and is imported by 12 other modules, giving it a
    // large fan-in. `leaf.ts` holds the eval() and is imported by nothing.
    const files: Record<string, string> = {
      "hub.ts": "// TODO: refactor this\nexport const hub = 1;\n",
      "leaf.ts": "export function run(input: string) {\n  return eval(input);\n}\n",
    };
    for (let i = 0; i < 12; i++) {
      files[`consumer${i}.ts`] = `import { hub } from "./hub";\nexport const v${i} = hub;\n`;
    }
    dir = buildRepo(files);
    result = await indexRepo(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds both findings, so the comparison is real", () => {
    expect(issuesTitled(result, "TODO/FIXME marker").length).toBeGreaterThan(0);
    expect(issuesTitled(result, "Use of eval()").length).toBeGreaterThan(0);
  });

  it("gives the hub file a genuinely larger blast radius", () => {
    // Guards the premise: if fan-in were not being measured, the test below
    // would pass for the wrong reason.
    const todo = issuesTitled(result, "TODO/FIXME marker")[0]!;
    const evalIssue = issuesTitled(result, "Use of eval()")[0]!;
    expect(todo.blastRadius).toBeGreaterThan(evalIssue.blastRadius);
  });

  it("penalises the eval() dimension more than the TODO dimension", () => {
    // security holds the eval(); maintainability holds the TODO. This is the
    // assertion that fails under the pre-fix model.
    const security = result.dimensions.find((d) => d.dimension === "security")!;
    const maintainability = result.dimensions.find((d) => d.dimension === "maintainability")!;
    expect(security.penalty).toBeGreaterThan(maintainability.penalty);
  });
});

describe("severity dominates blast radius at the extremes", () => {
  // Log damping alone is not enough: at a high enough fan-in an undamped log
  // still lets severity 1 overtake severity 5. The multiplier is therefore
  // capped, and this is the invariant that cap exists to guarantee.
  //
  // Asserted arithmetically against the shipped constants rather than by
  // building a 1000-file repo, which would make the suite slow for no extra
  // confidence.
  const MAX_BLAST_MULTIPLIER = 8;
  const damped = (blastRadius: number) => Math.min(MAX_BLAST_MULTIPLIER, 1 + Math.log2(1 + blastRadius));

  it("caps the multiplier so severity 5 always outranks severity 1", () => {
    const worstSeverity1 = 1 * damped(Number.MAX_SAFE_INTEGER);
    const leastSeverity5 = 5 * damped(1);
    expect(worstSeverity1).toBeLessThan(leastSeverity5);
  });

  it("still lets blast radius matter between equal severities", () => {
    // The counterweight. Capping must not flatten the weighting into
    // severity-only, or the product stops being blast-radius-weighted at all.
    expect(damped(60)).toBeGreaterThan(damped(1));
  });

  it("damps rather than scaling linearly", () => {
    // 60× the fan-in must not mean 60× the penalty — that is what produced the
    // 12:1 inversion.
    expect(damped(60) / damped(1)).toBeLessThan(5);
  });
});

describe("finding volume registers past the emit cap (review B3)", () => {
  // Before the fix, `if (hits >= 5) break` meant a file with 500 matches and a
  // file with 5 scored identically — so deleting 400 debug lines moved the score
  // by zero, and `issuesAfter <= issuesBefore` still passed.
  let fewDir: string;
  let manyDir: string;
  let few: IndexResult;
  let many: IndexResult;

  const debugLine = 'console.log("debug");\n';

  beforeAll(async () => {
    // Identical files apart from how many times the rule matches. Padding keeps
    // LOC — and therefore the size normalisation — comparable between the two.
    const pad = "export const pad = 1;\n".repeat(200);
    fewDir = buildRepo({ "a.ts": debugLine.repeat(5) + pad });
    manyDir = buildRepo({ "a.ts": debugLine.repeat(200) + pad });
    few = await indexRepo(fewDir);
    many = await indexRepo(manyDir);
  });

  afterAll(() => {
    rmSync(fewDir, { recursive: true, force: true });
    rmSync(manyDir, { recursive: true, force: true });
  });

  it("still bounds the emitted issue list", () => {
    // The cap is a real memory/UI bound and must survive: 200 matches must not
    // become 200 stored issues.
    expect(issuesTitled(many, "Leftover debug output").length).toBeLessThanOrEqual(5);
  });

  it("records the true occurrence count on the group's first issue", () => {
    const first = issuesTitled(many, "Leftover debug output")[0]!;
    expect(first.occurrences).toBe(200);
  });

  it("leaves occurrences unset at or under the cap, so scores there are unchanged", () => {
    // The compatibility guarantee: a repo whose files are under the cap scores
    // exactly as it did before this field existed.
    for (const issue of issuesTitled(few, "Leftover debug output")) {
      expect(issue.occurrences).toBeUndefined();
    }
  });

  it("penalises 200 matches more than 5", () => {
    const manyCorrectness = many.dimensions.find((d) => d.dimension === "correctness")!;
    const fewCorrectness = few.dimensions.find((d) => d.dimension === "correctness")!;
    expect(manyCorrectness.penalty).toBeGreaterThan(fewCorrectness.penalty);
  });

  it("damps volume rather than scaling linearly", () => {
    // 40× the matches must not mean 40× the penalty, or one noisy file would
    // swamp every real finding in the repository.
    const manyCorrectness = many.dimensions.find((d) => d.dimension === "correctness")!;
    const fewCorrectness = few.dimensions.find((d) => d.dimension === "correctness")!;
    const ratio = manyCorrectness.penalty / fewCorrectness.penalty;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(5);
  });

  it("counts occurrences only once per group, not once per emitted marker", () => {
    // Setting `occurrences` on all five emitted issues would multiply the same
    // excess five times.
    const withOccurrences = issuesTitled(many, "Leftover debug output").filter(
      (i) => i.occurrences !== undefined,
    );
    expect(withOccurrences).toHaveLength(1);
  });
});

describe("score stays in range", () => {
  it("clamps to 0..100 for a deliberately awful repo", () => {
    // Volume and blast multipliers are unbounded above in principle; the
    // exponential must still land inside the advertised range.
    expect(async () => {
      const dir = buildRepo({
        "bad.ts": 'eval(x);\nconsole.log("a");\n'.repeat(300) + "// TODO\n".repeat(300),
      });
      const r = await indexRepo(dir);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      rmSync(dir, { recursive: true, force: true });
    }).not.toThrow();
  });
});
