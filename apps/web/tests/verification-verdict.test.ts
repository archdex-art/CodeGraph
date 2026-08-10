import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GateResult, VerificationRecord } from "@codegraph/verify";
import { verdictFor } from "@/components/VerificationVerdict";

/**
 * PLAN.md §4: "Render reports `verified: partial`; CLI, desktop, and self-hosted Docker report
 * `verified: full`. The UI must render the two distinctly."
 *
 * WHY THIS IS A REAL REQUIREMENT and not polish. The verdict banner was
 * `res.verified ? emerald : amber` — one boolean, two colours. A run whose test suite never
 * executed carries `verified: true, level: "partial"` and rendered IDENTICALLY to one where the
 * suite ran and passed.
 *
 * That is review C3 re-told at the last possible moment. C3 was the executor computing
 * `verified` from the score the fix was built to move; the four gates fixed the computation.
 * A correct `partial` displayed as `full` puts the same false claim in front of the user
 * anyway — and SPIKES.md §2 records that Render grants no privileged containers, so gate 3
 * CANNOT run on the hosted demo. The deployment most people see is structurally incapable of
 * full verification, and it was showing the same green shield as a developer's own machine.
 */

const root = path.join(process.cwd(), "apps/web/src");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const gate = (g: GateResult["gate"], status: GateResult["status"], reason?: string): GateResult =>
  ({ gate: g, status, ms: 1, ...(reason ? { reason } : {}) });

const record = (level: VerificationRecord["level"], gates: GateResult[]): VerificationRecord =>
  ({ candidateId: "c1", gates, verified: !gates.some((g) => g.status === "failed"), level });

describe("verdictFor", () => {
  it("is `full` only when the suite actually ran and passed", () => {
    expect(
      verdictFor(record("full", [gate("syntax", "passed"), gate("tests", "passed"), gate("reanalysis", "passed")]))
    ).toBe("full");
  });

  it("is `partial` when the suite could not run — NOT `full`", () => {
    // The hosted-demo shape. This is the assertion the old banner could not make.
    const r = record("partial", [
      gate("syntax", "passed"),
      gate("types", "skipped", "no tsconfig.json in the project"),
      gate("tests", "skipped", "test verification not enabled (CG_ALLOW_TEST_VERIFICATION)"),
      gate("reanalysis", "passed"),
    ]);
    expect(verdictFor(r)).toBe("partial");
    expect(verdictFor(r)).not.toBe("full");
  });

  it("a failed gate outranks a `partial` level", () => {
    // `level` describes how much COULD run, so this combination is reachable.
    expect(verdictFor(record("partial", [gate("syntax", "passed"), gate("reanalysis", "failed")]))).toBe("failed");
  });

  it("a failed gate outranks a `full` level too", () => {
    expect(verdictFor(record("full", [gate("tests", "failed", "3 tests failed")]))).toBe("failed");
  });

  it("distinguishes a failed gate from nothing having run", () => {
    // Caught by looking at the rendered page: a failed-gate record read "no verification gate
    // completed", which is the opposite of what happened.
    expect(verdictFor(record("none", [gate("syntax", "skipped")]))).toBe("none");
    expect(verdictFor(record("none", [gate("syntax", "failed")]))).toBe("failed");
  });

  it("separates a patch that could not be verified from a run with nothing to patch", () => {
    /*
     * Both arrive with no record, and they mean opposite things. A run that produced edits and
     * then gated none of them is genuinely unverified. A run that produced NO edits has nothing
     * to verify, and rendering it as "Not verified — no verification gate completed" beside an
     * amber warning made the product's headline promise look like it had failed, on every
     * repository whose findings no provider claims.
     */
    expect(verdictFor(undefined, 3)).toBe("none");
    expect(verdictFor(undefined, 0)).toBe("nothing");
    // A real patch that WAS gated keeps its own verdict regardless of the count.
    expect(verdictFor(record("full", [gate("tests", "passed")]), 0)).toBe("full");
  });

  it("is `none` when the record says none", () => {
    expect(verdictFor(record("none", [gate("syntax", "skipped")]))).toBe("none");
  });
});

describe("the five verdicts are visually distinct", () => {
  // Source-level, matching this repo's convention for UI claims (see publish-consent.test.ts):
  // the requirement is about what a user can TELL APART, and the colour tokens are the thing
  // that differs. A shared palette would silently defeat the whole point.
  const src = read("components/VerificationVerdict.tsx");

  it("gives each level its own colour token", () => {
    // Scope to the LEVEL table — STATUS below has its own `fg` tokens for the gate chips.
    const levels = src.slice(src.indexOf("const LEVEL = {"), src.indexOf("const GATE_LABEL"));
    const fgs = [...levels.matchAll(/fg:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(fgs).toHaveLength(5);
    expect(new Set(fgs).size).toBe(5);
  });

  it("does not dress `nothing to fix` as a warning", () => {
    // The whole point of the fifth verdict: a no-op must not borrow the amber palette that
    // means "we could not check this", nor the green that means "we did".
    const block = src.slice(src.indexOf("nothing: {"), src.indexOf("none: {"));
    expect(block).not.toMatch(/amber|coral|accent-text/);
  });

  it("does not paint `partial` with the `full` palette", () => {
    // The specific regression: partial rendered emerald.
    const partialBlock = src.slice(src.indexOf("partial: {"), src.indexOf("none: {"));
    expect(partialBlock).not.toMatch(/emerald/);
  });

  it("says out loud that the test suite did not run", () => {
    // A different colour alone leaves the user guessing WHAT was weaker.
    expect(src).toMatch(/test suite did not run/i);
  });

  it("exposes the level for assertion in the DOM", () => {
    expect(src).toContain('data-level={level}');
  });
});

describe("AgentSwarm renders the verdict component", () => {
  it("no longer branches the banner on the bare `verified` boolean", () => {
    const swarm = read("components/AgentSwarm.tsx");
    expect(swarm).toContain("<VerificationVerdict");
    // The exact expression that made partial look like full.
    expect(swarm).not.toMatch(/res\.verified \? "border-emerald/);
  });
});
