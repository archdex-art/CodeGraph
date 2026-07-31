import { describe, expect, it } from "vitest";
import { sarifRuleId, toSarif } from "../src/sarif";
import type { Issue } from "../src/models";

/**
 * SARIF 2.1.0 export (ADR-006).
 *
 * The adapter appeared in HLD §3 as the mechanism satisfying the interoperability requirement
 * and existed nowhere in the code — the same shape of claim as HLD §8.3's tier ladder.
 *
 * These tests defend the DIRECTION as much as the format: SARIF is an export, and nothing about
 * it may leak into the internal model (IDENTITY.md §4.3).
 */
const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "i1",
  dimension: "security",
  severity: 5,
  confidence: 0.9,
  title: "Use of eval()",
  file: "src/a.ts",
  line: 12,
  blastRadius: 3,
  ...over,
});

describe("toSarif", () => {
  it("emits a valid 2.1.0 envelope", () => {
    const log = toSarif([issue()]);
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.name).toBe("CodeGraph");
  });

  it("maps severity onto SARIF's three levels", () => {
    const level = (severity: number) => toSarif([issue({ severity })]).runs[0].results[0].level;
    expect(level(5)).toBe("error");
    expect(level(4)).toBe("error");
    expect(level(3)).toBe("warning");
    expect(level(2)).toBe("note");
    expect(level(1)).toBe("note");
  });

  it("keeps the original severity and confidence in properties", () => {
    // The three-level collapse is lossy; a consumer that wants the real numbers must still
    // find them, or the export is strictly worse than the API it wraps.
    const props = toSarif([issue({ severity: 4, confidence: 0.7 })]).runs[0].results[0].properties;
    expect(props).toMatchObject({ severity: 4, confidence: 0.7, dimension: "security" });
  });

  it("omits confidence rather than inventing one when absent", () => {
    const props = toSarif([issue({ confidence: undefined })]).runs[0].results[0].properties;
    expect("confidence" in props).toBe(false);
  });

  it("derives one stable rule per distinct title", () => {
    // A consumer diffing two runs keys on ruleId; regenerating ids per result would make every
    // finding look new.
    const log = toSarif([issue(), issue({ line: 40 }), issue({ title: "Empty catch block" })]);
    expect(log.runs[0].tool.driver.rules).toHaveLength(2);
    expect(log.runs[0].results).toHaveLength(3);
    expect(sarifRuleId("Use of eval()")).toBe("codegraph/use-of-eval");
  });

  it("emits POSIX-relative artifact URIs", () => {
    // Absolute or Windows-separated paths make the log unusable on another machine.
    const loc = toSarif([issue({ file: "src\\win\\a.ts" })]).runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe("src/win/a.ts");
  });

  it("never emits startLine below 1, which SARIF forbids", () => {
    const r = toSarif([issue({ line: 0 })]).runs[0].results[0].locations[0].physicalLocation.region;
    expect(r.startLine).toBe(1);
  });

  it("publishes no rank, so there is only one CodeGraph ranking", () => {
    // SARIF offers a 0-100 priority field. Filling it would export a second ordering that can
    // disagree with the Health Score; the inputs are in `properties` instead.
    const result = toSarif([issue()]).runs[0].results[0] as unknown as Record<string, unknown>;
    expect("rank" in result).toBe(false);
  });

  it("publishes no partialFingerprints while findings carry no fingerprint", () => {
    // `@codegraph/core-domain` has a real fingerprint keyed on a normalised snippet, not
    // available here. A weaker hash under the standard name would silently disagree with the
    // product's own identity for a finding.
    const result = toSarif([issue()]).runs[0].results[0] as unknown as Record<string, unknown>;
    expect("partialFingerprints" in result).toBe(false);
  });

  it("handles an empty run without producing a malformed log", () => {
    const log = toSarif([]);
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].tool.driver.rules).toEqual([]);
  });
});
