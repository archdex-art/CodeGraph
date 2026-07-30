import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-scoped-"));
process.env["CG_DATA_DIR"] = dataDir;
process.env["CG_ALLOW_LOCAL_ACCESS"] = "true";

const P = await import("@codegraph/persistence");
const { indexRepo } = await import("@codegraph/analysis");
const { executeFixes } = await import("@/lib/agents/executor");
const { fixersForRule } = await import("@/lib/agents/fixers");

const repos: string[] = [];

/**
 * Review C1: a fix scoped to one finding (LLD §7.1, §9.2).
 *
 * The bug being closed, in its own words from REVIEW_2026-07-29: clicking the P0
 * "Untrusted input reaches eval()" finding produced a diff that deleted `console.log` in 27
 * unrelated files, because the executor ran all fixers over all files and ignored the
 * finding entirely.
 *
 * A real temp repository is used rather than fixtures: the claim is about which files an end
 * to end run touches, so anything short of running it would assume the answer.
 */
/**
 * The fixture is built so that EACH filter is independently necessary. An earlier version
 * gave the target file only an empty catch and the other files only `console.log`, which made
 * the two filters redundant: removing either one still produced a 1-file, 1-edit result, so
 * both mutants survived and the tests passed for the wrong reason.
 *
 * Now every file carries BOTH an empty catch and a `console.log`, so:
 *   · dropping the FILE filter lets `annotate-empty-catch` touch all nine files;
 *   · dropping the FIXER filter lets `remove-debug-output` add a second edit in target.js.
 * Each is caught by a different assertion.
 */
function buildRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-c1-repo-"));
  repos.push(root);
  const body = (n: string) => `console.log("debug ${n}");\ntry { risky(); } catch (e) {}\nexport const v${n} = ${n};\n`;
  writeFileSync(path.join(root, "target.js"), body("0"));
  for (let i = 1; i <= 8; i++) writeFileSync(path.join(root, `other${i}.js`), body(String(i)));
  return root;
}

async function seed(root: string) {
  const result = await indexRepo(root);
  P.insertRepo({ id: "r1", url: root, name: "c1", sourceType: "local", ownerId: null, createdAt: 1 });
  P.recordRun(
    { id: "run-1", repoId: "r1", commitSha: null, score: result.score, loc: result.loc, startedAt: 1, finishedAt: 2 },
    result.issues
  );
  const repo = {
    id: "r1", url: root, name: "c1", status: "done", sourceType: "local",
    score: result.score, loc: result.loc, createdAt: 1, finishedAt: 2, hasWorkspace: false, error: null,
    languages: result.languages, graphStats: result.graphStats, dimensions: result.dimensions,
    issues: result.issues, dependencies: result.dependencies, churnByFile: result.churnByFile,
    tree: result.tree, viz: result.viz, modules: result.modules, symbolGraph: result.symbolGraph,
  };
  return { repo, result };
}

beforeEach(() => {
  P.db().exec("DELETE FROM findings");
  P.db().exec("DELETE FROM runs");
  P.db().exec("DELETE FROM repos");
});

afterAll(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("executeFixes with a scope (review C1)", () => {
  it("touches ONE file, where the unscoped run touches nine", async () => {
    const root = buildRepo();
    const { repo } = await seed(root);
    const target = P.findingsForRun("run-1").find((f) => f.rule_id === "legacy/empty-catch-block");
    expect(target).toBeDefined();

    const wide = await executeFixes(repo as never);
    const scoped = await executeFixes(repo as never, undefined, {
      file: target!.file,
      fixerIds: fixersForRule(target!.rule_id).map((f) => f.id),
      targetFingerprint: target!.fingerprint,
    });

    // The bug, and the fix, in one comparison.
    expect(wide.filesChanged).toBeGreaterThan(1);
    expect(scoped.filesChanged).toBe(1);
    expect(scoped.edits.every((e) => e.file === target!.file)).toBe(true);

    // EXACTLY one edit: the empty-catch annotation. Every file also contains a
    // `console.log`, so a scoped run that let `remove-debug-output` through would report 2.
    // This is what makes the fixer filter independently load-bearing.
    expect(scoped.applied).toBe(1);
    expect(scoped.edits.map((e) => e.fixer)).toEqual(["annotate-empty-catch"]);
  });

  it("makes gate 4's STRONG claim — this finding is gone, not merely nothing new", async () => {
    // The upgrade C1 unlocks for C3. The batch path cannot name a target, so it can only
    // verify that nothing new appeared.
    const root = buildRepo();
    const { repo } = await seed(root);
    const target = P.findingsForRun("run-1").find((f) => f.rule_id === "legacy/empty-catch-block")!;

    const scoped = await executeFixes(repo as never, undefined, {
      file: target.file,
      fixerIds: fixersForRule(target.rule_id).map((f) => f.id),
      targetFingerprint: target.fingerprint,
    });
    const gate4 = scoped.verification?.gates.find((g) => g.gate === "reanalysis");
    expect(gate4?.status).toBe("passed");
    expect(gate4?.reason).toMatch(/target fingerprint absent/);
    expect(gate4?.reason).not.toMatch(/does not prove a specific finding/);

    const wide = await executeFixes(repo as never);
    const wideGate4 = wide.verification?.gates.find((g) => g.gate === "reanalysis");
    expect(wideGate4?.reason).toMatch(/does not prove a specific finding/);
  });

  it("names the real providers rather than reporting a targeted fix as a batch", async () => {
    const root = buildRepo();
    const { repo } = await seed(root);
    const target = P.findingsForRun("run-1").find((f) => f.rule_id === "legacy/empty-catch-block")!;

    const scoped = await executeFixes(repo as never, undefined, {
      file: target.file,
      fixerIds: fixersForRule(target.rule_id).map((f) => f.id),
      targetFingerprint: target.fingerprint,
    });
    expect(scoped.verification?.gates.find((g) => g.gate === "reanalysis")?.reason).toContain(
      "annotate-empty-catch"
    );
  });

  it("leaves the unrelated files untouched on disk", async () => {
    // Belt and braces on the headline claim: assert the CONTENT of a file the scoped run had
    // no business editing. `filesChanged` is a count the executor reports about itself.
    const root = buildRepo();
    const { repo } = await seed(root);
    const target = P.findingsForRun("run-1").find((f) => f.rule_id === "legacy/empty-catch-block")!;
    const before = readFileSync(path.join(root, "other3.js"), "utf8");

    await executeFixes(repo as never, undefined, {
      file: target.file,
      fixerIds: fixersForRule(target.rule_id).map((f) => f.id),
      targetFingerprint: target.fingerprint,
    });

    // The executor works in a sandbox copy, so the original must be byte-identical either
    // way — this asserts the sandbox promise as well as the scope.
    expect(readFileSync(path.join(root, "other3.js"), "utf8")).toBe(before);
    expect(before).toContain("console.log");
  });
});
