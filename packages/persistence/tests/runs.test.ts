import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-runs-"));
process.env["CG_DATA_DIR"] = dataDir;

const {
  db,
  findingById,
  findingsForRun,
  insertRepo,
  latestRunId,
  legacyRuleId,
  newFindingsSince,
  recordRun,
  repoIdForFinding,
} = await import("../src/index");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
  db().exec("DELETE FROM findings");
  db().exec("DELETE FROM runs");
  db().exec("DELETE FROM repos");
  insertRepo({
    id: "r1",
    url: "/tmp/x",
    name: "x",
    sourceType: "local",
    ownerId: null,
    createdAt: 1,
  });
});

const run = (id: string, at = 1000) => ({
  id,
  repoId: "r1",
  commitSha: null,
  score: 90,
  loc: 10,
  startedAt: at,
  finishedAt: at + 1,
});

const issue = (title: string, file: string, line = 1) => ({
  title,
  file,
  line,
  dimension: "correctness",
  severity: 2,
  confidence: 1,
});

/**
 * Writing runs and findings.
 *
 * The gap these close was measured, not theorised: migration 002 created these tables and
 * 003 backfilled them, then nothing wrote to them again. A freshly indexed repository
 * produced 4 issues in `repos.issues` and 0 rows in `findings`, so `latestRunId()` returned
 * null for every repo indexed after the migration — and review C1's per-finding `/fix` had
 * no `findingId` to address.
 */
describe("recordRun", () => {
  it("makes a run discoverable, which it was not before", () => {
    expect(latestRunId("r1")).toBeNull();
    recordRun(run("run-1"), [issue("Leftover debug output", "a.js")]);
    expect(latestRunId("r1")).toBe("run-1");
  });

  it("writes one findings row per issue", () => {
    recordRun(run("run-1"), [
      issue("Leftover debug output", "a.js"),
      issue("TODO/FIXME marker", "a.js", 2),
    ]);
    expect(findingsForRun("run-1")).toHaveLength(2);
  });

  it("assigns rule ids that match the fixer bindings", () => {
    // The whole point of C1: a finding's rule id has to be the same string a fixer declares
    // in `handles`, or the binding resolves to nothing.
    recordRun(run("run-1"), [issue("Leftover debug output", "a.js")]);
    expect(findingsForRun("run-1")[0]?.rule_id).toBe("legacy/leftover-debug-output");
    expect(legacyRuleId("Leftover debug output")).toBe("legacy/leftover-debug-output");
  });

  it("assigns a non-empty fingerprint to every finding", () => {
    // P6's baseline mode and gate 4 both key on this column.
    recordRun(run("run-1"), [issue("Empty catch block", "a.js")]);
    const fp = findingsForRun("run-1")[0]?.fingerprint;
    expect(fp).toBeTruthy();
    expect(fp).not.toBe("");
  });

  it("keeps a fingerprint stable when the finding MOVES, so diffs work", () => {
    // `newFindingsSince` diffs fingerprints, so an unstable one reports every pre-existing
    // finding as new on every run — the single most annoying possible failure of this
    // feature.
    //
    // The finding is at line 1 and ordinal 0 in run-1, then line 42 and ordinal 1 in run-2.
    // Both axes have to be irrelevant: an earlier version of this test reused identical
    // line and ordinal, so folding either INTO the fingerprint left it passing. Verified by
    // doing exactly that and watching it survive.
    recordRun(run("run-1", 1000), [issue("Empty catch block", "a.js", 1)]);
    recordRun(run("run-2", 2000), [
      issue("Leftover debug output", "b.js", 7),
      issue("Empty catch block", "a.js", 42),
    ]);

    const before = findingsForRun("run-1").find((f) => f.rule_id === "legacy/empty-catch-block");
    const after = findingsForRun("run-2").find((f) => f.rule_id === "legacy/empty-catch-block");
    expect(after?.fingerprint).toBe(before?.fingerprint);
    // And the moved finding is not reported as new.
    expect(newFindingsSince("run-2", "run-1").map((f) => f.rule_id)).toEqual([
      "legacy/leftover-debug-output",
    ]);
  });

  it("reports a genuinely new finding as new", () => {
    recordRun(run("run-1", 1000), [issue("Empty catch block", "a.js")]);
    recordRun(run("run-2", 2000), [
      issue("Empty catch block", "a.js"),
      issue("Leftover debug output", "b.js"),
    ]);
    const fresh = newFindingsSince("run-2", "run-1");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.rule_id).toBe("legacy/leftover-debug-output");
  });

  it("produces stable ids for a re-run of the same analysis", () => {
    recordRun(run("run-1"), [issue("Empty catch block", "a.js")]);
    expect(findingsForRun("run-1")[0]?.id).toBe("run-1:0");
  });

  it("writes nothing when the run cannot be inserted", () => {
    // Atomicity, provoked with a real constraint violation rather than a contrived value: a
    // duplicate run id hits the PRIMARY KEY on `runs`. An earlier version passed
    // `dimension: null` expecting a NOT NULL failure, but `recordRun` coerces that with
    // `?? "maintainability"` before SQLite sees it — the test threw nothing and proved
    // nothing.
    //
    // LIMIT OF THIS TEST, stated because removing the transaction does NOT fail it: the
    // failure here lands on the first statement, so no finding was written either way.
    // Findings-level rollback is not reachable through this API at all — every field is
    // coerced to something valid before insert — so the transaction is defence for a future
    // field that is not, and this asserts only the part that is observable. Naming that is
    // better than a test that appears to cover it.
    recordRun(run("run-1"), [issue("Empty catch block", "a.js")]);
    expect(() => recordRun(run("run-1"), [issue("Leftover debug output", "b.js")])).toThrow();

    // The first run's findings survive, and the failed call added none.
    expect(findingsForRun("run-1")).toHaveLength(1);
    expect(db().prepare("SELECT COUNT(*) c FROM findings").get()).toEqual({ c: 1 });
    expect(db().prepare("SELECT COUNT(*) c FROM runs").get()).toEqual({ c: 1 });
  });

  it("records no findings for a clean repository, without failing", () => {
    recordRun(run("run-1"), []);
    expect(latestRunId("r1")).toBe("run-1");
    expect(findingsForRun("run-1")).toHaveLength(0);
  });
});

describe("findingById / repoIdForFinding", () => {
  it("resolves a finding and the repo it belongs to", () => {
    // Both are what a per-finding route needs: the rule id to pick a fixer, and the repo to
    // make the tenant check before acting.
    recordRun(run("run-1"), [issue("Empty catch block", "a.js", 3)]);
    const found = findingById("run-1:0");
    expect(found?.rule_id).toBe("legacy/empty-catch-block");
    expect(found?.file).toBe("a.js");
    expect(found?.start_line).toBe(3);
    expect(repoIdForFinding("run-1:0")).toBe("r1");
  });

  it("returns null for an unknown id rather than throwing", () => {
    expect(findingById("nope")).toBeNull();
    expect(repoIdForFinding("nope")).toBeNull();
  });
});
