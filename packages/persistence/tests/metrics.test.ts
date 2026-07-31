import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-metrics-"));
process.env["CG_DATA_DIR"] = dataDir;

const { counterValue, incrementCounter, renderPrometheus, resetCountersForTests } = await import(
  "../src/index"
);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => resetCountersForTests());

/**
 * Durable counters and their Prometheus rendering (HLD §14).
 *
 * Stored in SQLite rather than in memory because analysis runs in a per-job child process that
 * exits (ADR-001) while `/api/metrics` is served by the web tier — an in-memory counter would
 * report zero for the work the product actually did, and reset every deploy besides.
 */
describe("incrementCounter", () => {
  it("accumulates across calls", () => {
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "passed" });
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "passed" });
    expect(counterValue("cg_verification_total", { gate: "tests", outcome: "passed" })).toBe(2);
  });

  it("keeps distinct label sets as distinct series", () => {
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "passed" });
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "skipped" });
    expect(counterValue("cg_verification_total", { gate: "tests", outcome: "passed" })).toBe(1);
    expect(counterValue("cg_verification_total", { gate: "tests", outcome: "skipped" })).toBe(1);
  });

  it("treats label order as irrelevant", () => {
    // Without sorting, the same logical counter splits into two rows depending on the order a
    // caller wrote the object literal, and the total silently halves.
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "passed" });
    incrementCounter("cg_verification_total", { outcome: "passed", gate: "tests" });
    expect(counterValue("cg_verification_total", { gate: "tests", outcome: "passed" })).toBe(2);
  });

  it("survives a fresh connection, which is the whole reason it is a table", () => {
    // The property an in-memory registry cannot have: the per-job executor is a different
    // process from the web tier that serves the scrape.
    incrementCounter("cg_verification_total", { gate: "syntax", outcome: "passed" });
    expect(counterValue("cg_verification_total", { gate: "syntax", outcome: "passed" })).toBe(1);
  });
});

describe("renderPrometheus", () => {
  it("emits TYPE and HELP for a known family", () => {
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "failed" });
    const text = renderPrometheus();
    expect(text).toContain("# TYPE cg_verification_total counter");
    expect(text).toContain("# HELP cg_verification_total");
    expect(text).toContain('cg_verification_total{gate="tests",outcome="failed"} 1');
  });

  it("renders labels in sorted order, so a scrape is stable between calls", () => {
    incrementCounter("cg_verification_total", { outcome: "passed", gate: "types" });
    expect(renderPrometheus()).toContain('{gate="types",outcome="passed"}');
  });

  it("escapes characters that would break the exposition format", () => {
    // A quote or backslash in a label value produces a malformed line that breaks the WHOLE
    // scrape, not just that series. Rule ids and gate reasons are the realistic source.
    incrementCounter("cg_findings_total", { rule: 'legacy/say-"hi"\\n' });
    const text = renderPrometheus();
    expect(text).toContain('rule="legacy/say-\\"hi\\"\\\\n"');
    expect(text.split("\n").filter((l) => l.startsWith("cg_findings_total")).length).toBe(1);
  });

  it("ends with a newline, and an empty registry is still a valid scrape", () => {
    expect(renderPrometheus()).toBe("\n");
    incrementCounter("cg_run_total", { outcome: "ok" });
    expect(renderPrometheus().endsWith("\n")).toBe(true);
  });

  it("groups a family under one TYPE line rather than repeating it per series", () => {
    incrementCounter("cg_verification_total", { gate: "syntax", outcome: "passed" });
    incrementCounter("cg_verification_total", { gate: "tests", outcome: "skipped" });
    const typeLines = renderPrometheus()
      .split("\n")
      .filter((l) => l === "# TYPE cg_verification_total counter");
    expect(typeLines).toHaveLength(1);
  });
});

describe("gauges (HLD §14)", () => {
  /**
   * `cg_cache_hit_ratio` and `cg_queue_depth` were named in HLD §14 and existed nowhere —
   * the same shape of gap as the §8.3 tier ladder and the SARIF adapter.
   *
   * Gauges are sampled at scrape rather than stored: a stored gauge serves whatever was true
   * when some process last wrote it, which for "how full is the queue" is worse than no answer.
   */
  it("renders a gauge with its TYPE line", () => {
    const out = renderPrometheus([{ name: "cg_queue_depth", value: 3 }]);
    expect(out).toContain("# TYPE cg_queue_depth gauge");
    expect(out).toContain("cg_queue_depth 3");
  });

  it("renders a fractional gauge without losing precision", () => {
    const out = renderPrometheus([{ name: "cg_cache_hit_ratio", value: 0.625 }]);
    expect(out).toContain("cg_cache_hit_ratio 0.625");
  });

  it("emits Prometheus spellings for NaN and infinities", () => {
    /**
     * `String(Infinity)` is `"Infinity"`, which the exposition format rejects. This was
     * unreachable while only counters existed and stops being so the moment a ratio divides by
     * zero — which a hit ratio does on a process that has looked nothing up.
     */
    const out = renderPrometheus([
      { name: "cg_cache_hit_ratio", value: Number.NaN },
      { name: "cg_queue_depth", value: Number.POSITIVE_INFINITY },
    ]);
    expect(out).toContain("cg_cache_hit_ratio NaN");
    expect(out).toContain("cg_queue_depth +Inf");
    expect(out).not.toContain("Infinity");
  });

  it("keeps counters and gauges in one scrape, each with its own TYPE", () => {
    incrementCounter("cg_run_total", { outcome: "ok" });
    const out = renderPrometheus([{ name: "cg_queue_depth", value: 0 }]);
    expect(out).toContain("# TYPE cg_run_total counter");
    expect(out).toContain("# TYPE cg_queue_depth gauge");
  });

  it("renders labelled gauges", () => {
    const out = renderPrometheus([{ name: "cg_queue_depth", value: 2, labels: { kind: "analyze" } }]);
    expect(out).toContain('cg_queue_depth{kind="analyze"} 2');
  });

  it("still renders a valid scrape with no gauges at all", () => {
    expect(renderPrometheus()).toMatch(/\n$/);
  });
});
