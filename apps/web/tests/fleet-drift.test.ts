import { describe, expect, it } from "vitest";
import { compareDrift, driftLabel, rankByDrift } from "@/lib/fleet-drift";
import type { RepoDrift } from "@/lib/types";

/**
 * The ordering both list views rank by.
 *
 * Worth a test rather than an eyeball because the interesting cases are the ones a
 * screenshot cannot distinguish: a repo indexed once and a repo that did not move both
 * have "no delta", and ranking them together is precisely the bug the drift view exists
 * to avoid.
 */

const drift = (d: Partial<RepoDrift>): RepoDrift => ({
  findings: 0,
  scoreDelta: null,
  findingsDelta: null,
  failed: false,
  ...d,
});

const row = (name: string, d: RepoDrift | null) => ({ id: name, name, drift: d });

describe("rankByDrift", () => {
  it("puts the biggest movers first and a failed index above all of them", () => {
    const ranked = rankByDrift([
      row("steady", drift({ scoreDelta: 0, findingsDelta: 0 })),
      row("small-mover", drift({ scoreDelta: -2, findingsDelta: 1 })),
      row("failed", drift({ failed: true, scoreDelta: 0, findingsDelta: 0 })),
      row("big-mover", drift({ scoreDelta: 5, findingsDelta: -20 })),
      row("fresh", drift({ scoreDelta: null, findingsDelta: null })),
      row("never-indexed", null),
    ]);

    expect(ranked.map((r) => r.name)).toEqual([
      "failed",
      "big-mover",
      "small-mover",
      "fresh",
      "never-indexed",
      "steady",
    ]);
  });

  it("ranks a repo indexed once as a first index, never as a zero delta", () => {
    const fresh = row("fresh", drift({ scoreDelta: null, findingsDelta: null }));
    const unchanged = row("unchanged", drift({ scoreDelta: 0, findingsDelta: 0 }));

    expect(compareDrift(fresh, unchanged)).toBeLessThan(0);
    expect(driftLabel(fresh.drift)).toBe("first index");
    expect(driftLabel(unchanged.drift)).toBe("no change");
  });

  it("counts a findings swing as movement even when the score held", () => {
    const findingsOnly = row("findings-only", drift({ scoreDelta: 0, findingsDelta: 30 }));
    const scoreOnly = row("score-only", drift({ scoreDelta: 3, findingsDelta: 0 }));

    expect(rankByDrift([scoreOnly, findingsOnly]).map((r) => r.name)).toEqual([
      "findings-only",
      "score-only",
    ]);
  });

  it("breaks a magnitude tie towards the regression", () => {
    const worse = row("worse", drift({ scoreDelta: -4, findingsDelta: 0 }));
    const better = row("better", drift({ scoreDelta: 4, findingsDelta: 0 }));

    expect(rankByDrift([better, worse]).map((r) => r.name)).toEqual(["worse", "better"]);
    expect(driftLabel(worse.drift)).toBe("\u22124 score");
    expect(driftLabel(better.drift)).toBe("+4 score");
  });

  it("is stable for rows that are equal in every ranked respect", () => {
    const a = row("alpha", drift({ scoreDelta: 1, findingsDelta: 0 }));
    const b = row("beta", drift({ scoreDelta: 1, findingsDelta: 0 }));

    expect(rankByDrift([b, a]).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(rankByDrift([a, b]).map((r) => r.name)).toEqual(["alpha", "beta"]);
  });
});
