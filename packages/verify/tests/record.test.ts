import { describe, expect, it } from "vitest";
import { buildRecord, describeRecord, type GateResult } from "../src/index";

/**
 * What `verified` and `level` mean (LLD §7.2, review item C3).
 *
 * These tests are the specification. Shipped code decides verification with
 * `after.score >= before.score` (agents/executor.ts:179) — the metric the fix was built to
 * move — so the rules below are exactly the thing that was missing, and each one is stated
 * as a case that would have passed under the old expression.
 */

const gate = (
  g: GateResult["gate"],
  status: GateResult["status"],
  reason?: string
): GateResult => ({ gate: g, status, ms: 1, ...(reason ? { reason } : {}) });

describe("buildRecord — verified", () => {
  it("is true when every gate passed", () => {
    const r = buildRecord("c1", [
      gate("syntax", "passed"),
      gate("types", "passed"),
      gate("tests", "passed"),
      gate("reanalysis", "passed"),
    ]);
    expect(r.verified).toBe(true);
    expect(r.level).toBe("full");
  });

  it("is FALSE when every gate skipped, even though nothing failed", () => {
    // The case that motivates the floor. "No gate failed" is trivially true of a run where
    // nothing ran, and reporting that as verified is the same overclaim as grading a fix by
    // the metric it was built to move.
    const r = buildRecord("c1", [
      gate("syntax", "skipped"),
      gate("types", "skipped"),
      gate("tests", "skipped"),
      gate("reanalysis", "skipped"),
    ]);
    expect(r.verified).toBe(false);
    expect(r.level).toBe("none");
  });

  it("is false when reanalysis did not run, even with tests passing", () => {
    // Tests passing proves the repository still works. It does not prove THIS finding was
    // fixed — that is only gate 4.
    const r = buildRecord("c1", [gate("syntax", "passed"), gate("tests", "passed")]);
    expect(r.verified).toBe(false);
  });

  it("is false when syntax did not run", () => {
    const r = buildRecord("c1", [gate("reanalysis", "passed")]);
    expect(r.verified).toBe(false);
  });

  it("is false when any gate failed, however many passed", () => {
    const r = buildRecord("c1", [
      gate("syntax", "passed"),
      gate("reanalysis", "passed"),
      gate("tests", "failed", "3 specs failed"),
    ]);
    expect(r.verified).toBe(false);
    expect(r.level).toBe("none");
  });
});

describe("buildRecord — level", () => {
  it("is partial when the required gates passed but no suite ran", () => {
    // The Render case (SPIKES §2): everything checkable was checked, and the strongest
    // available evidence was unavailable. Verified, but not test-backed.
    const r = buildRecord("c1", [
      gate("syntax", "passed"),
      gate("reanalysis", "passed"),
      gate("tests", "skipped", "no test script in the manifest"),
    ]);
    expect(r.verified).toBe(true);
    expect(r.level).toBe("partial");
  });

  it("is partial when the tests gate is absent entirely", () => {
    const r = buildRecord("c1", [gate("syntax", "passed"), gate("reanalysis", "passed")]);
    expect(r.level).toBe("partial");
  });

  it("is full only when the suite actually ran and passed", () => {
    const r = buildRecord("c1", [
      gate("syntax", "passed"),
      gate("reanalysis", "passed"),
      gate("tests", "passed"),
    ]);
    expect(r.level).toBe("full");
  });
});

describe("describeRecord", () => {
  it("does not claim tests ran when they did not", () => {
    // The shipped PR body says "verified by re-indexing", which a reader hears as "the
    // tests were run". For a partial record they were not, and the summary has to say so.
    const summary = describeRecord(
      buildRecord("c1", [
        gate("syntax", "passed"),
        gate("reanalysis", "passed"),
        gate("tests", "skipped"),
      ])
    );
    expect(summary).toMatch(/not test-backed/);
    expect(summary).not.toMatch(/tests passed/);
  });

  it("says the tests passed when they did", () => {
    const summary = describeRecord(
      buildRecord("c1", [
        gate("syntax", "passed"),
        gate("reanalysis", "passed"),
        gate("tests", "passed"),
      ])
    );
    expect(summary).toMatch(/own tests passed/);
  });

  it("names which gate failed", () => {
    const summary = describeRecord(
      buildRecord("c1", [gate("syntax", "passed"), gate("reanalysis", "failed")])
    );
    expect(summary).toMatch(/Not verified/);
    expect(summary).toMatch(/reanalysis/);
  });

  it("distinguishes 'a gate failed' from 'the required gates did not run'", () => {
    const summary = describeRecord(buildRecord("c1", [gate("types", "skipped")]));
    expect(summary).toMatch(/required gates did not run/);
  });
});
