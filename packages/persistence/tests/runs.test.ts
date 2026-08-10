import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-runs-"));
process.env["CG_DATA_DIR"] = dataDir;

const {
  db,
  findingById,
  findingsForRun,
  upsertRepo,
  latestRunCoverage,
  latestRunId,
  legacyRuleId,
  newFindingsSince,
  pruneRunsForRepo,
  recordRun,
  repoIdForFinding,
} = await import("../src/index");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
  db().exec("DELETE FROM findings");
  db().exec("DELETE FROM runs");
  db().exec("DELETE FROM repos");
  upsertRepo({
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

/**
 * Retention.
 *
 * Nothing deleted a run or a finding before this: the tables were append-only for the life
 * of the install. That was survivable while an index was a manual, once-per-repo action and
 * stopped being survivable when auto-re-index made it up to 360 writes an hour per actively
 * edited repo. Measured against this schema, a run with its 200 findings and their three
 * indexes costs ~100 KB, so ~10,700 runs fill the 1 GB disk — a disk with no backup, where
 * SQLITE_FULL fails every write path including the next boot's migration runner.
 */
describe("run retention", () => {
  it("keeps exactly the newest 20 runs for a repo", () => {
    for (let i = 0; i < 25; i++) recordRun(run(`run-${i}`, 1000 + i), []);

    const ids = (
      db()
        .prepare("SELECT id FROM runs WHERE repo_id = 'r1' ORDER BY started_at ASC")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);

    // Not just the count: the newest are what must survive. An off-by-one that kept the
    // OLDEST 20 would also leave 20 rows behind, and would make the dashboard permanently
    // show a stale run.
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `run-${i + 5}`));
    expect(latestRunId("r1")).toBe("run-24");
  });

  it("takes the pruned runs' findings with them", () => {
    // The findings are the bulk of the 100 KB — 200 rows across three indexes per run. If
    // the FK cascade were not in effect (PRAGMA foreign_keys defaults OFF per connection),
    // pruning would reclaim the small half and orphan the large one.
    for (let i = 0; i < 22; i++) recordRun(run(`run-${i}`, 1000 + i), [issue("Empty catch block", "a.js")]);

    expect(findingsForRun("run-0")).toHaveLength(0);
    expect(findingsForRun("run-21")).toHaveLength(1);
    expect(db().prepare("SELECT COUNT(*) c FROM findings").get()).toEqual({ c: 20 });
    // No findings row survives whose run is gone.
    expect(
      db()
        .prepare("SELECT COUNT(*) c FROM findings f LEFT JOIN runs r ON r.id = f.run_id WHERE r.id IS NULL")
        .get(),
    ).toEqual({ c: 0 });
  });

  it("prunes only the repo it was asked about", () => {
    // The DELETE is repo-scoped on both sides of the NOT IN. Dropping the scope from the
    // subquery would silently delete every OTHER repo's history the moment one repo passed
    // the cap — the worst possible failure for a retention policy.
    upsertRepo({ id: "r2", url: "/tmp/y", name: "y", sourceType: "local", ownerId: null, createdAt: 1 });
    recordRun({ ...run("other-1", 500), repoId: "r2" }, []);
    for (let i = 0; i < 25; i++) recordRun(run(`run-${i}`, 1000 + i), []);

    expect(db().prepare("SELECT COUNT(*) c FROM runs WHERE repo_id = 'r2'").get()).toEqual({ c: 1 });
  });

  it("honours an explicit keep count", () => {
    for (let i = 0; i < 5; i++) recordRun(run(`run-${i}`, 1000 + i), []);
    pruneRunsForRepo("r1", 2);
    expect(db().prepare("SELECT COUNT(*) c FROM runs WHERE repo_id = 'r1'").get()).toEqual({ c: 2 });
    expect(latestRunId("r1")).toBe("run-4");
  });
});

describe("recordRun error reporting", () => {
  it("reports the failure that opened the transaction, not a rollback error", () => {
    // The BEGIN used to sit INSIDE the try with an unconditional ROLLBACK in the catch. When
    // the BEGIN itself failed — reachable in production, where the web tier and apps/worker
    // share one SQLite file and busy_timeout = 5000 is exhaustible by the other process's
    // index-time write — the catch issued a ROLLBACK with no transaction active, SQLite threw
    // "cannot rollback - no transaction is active", and THAT replaced the SQLITE_BUSY on its
    // way to the caller. The operator then debugged a transaction bug that did not exist.
    //
    // Spied on the real handle rather than faked, so the ROLLBACK below reaches real SQLite
    // and produces the real masking error if the fix is reverted.
    const database = db();
    const realExec = database.exec.bind(database);
    const spy = vi.spyOn(database, "exec").mockImplementation((sql: string) => {
      if (sql.startsWith("BEGIN")) throw new Error("SQLITE_BUSY: database is locked");
      realExec(sql);
    });

    try {
      expect(() => recordRun(run("run-1"), [issue("Empty catch block", "a.js")])).toThrow(/SQLITE_BUSY/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("latestRunCoverage", () => {
  it("agrees with latestRunId when start and finish order disagree", () => {
    // A long run started first and finished last is ordinary: an index of a big repo racing
    // a re-index of the same one. Ordering coverage by finished_at made this function pick a
    // DIFFERENT run from `latestRunId` (started_at DESC), so the dashboard showed one run's
    // findings beside another run's coverage. started_at also matches the only index on the
    // table, idx_runs_repo(repo_id, started_at DESC), so the query stops temp-sorting the
    // repo's whole history on every dashboard open.
    recordRun({ ...run("early-long"), startedAt: 1000, finishedAt: 5000, coverage: { files: 1 } }, []);
    recordRun({ ...run("later-short"), startedAt: 2000, finishedAt: 3000, coverage: { files: 2 } }, []);

    expect(latestRunId("r1")).toBe("later-short");
    expect(latestRunCoverage("r1")).toEqual({ files: 2 });
  });
});
