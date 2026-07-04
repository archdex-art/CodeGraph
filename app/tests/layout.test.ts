import { describe, expect, it } from "vitest";
import { forceLayout, layeredLayout } from "@/lib/layout";
import type { SimEdge } from "@/lib/layout";

const IDS = ["n0", "n1", "n2", "n3", "n4", "n5"];
const EDGES: SimEdge[] = [
  { source: "n0", target: "n1" },
  { source: "n1", target: "n2" },
  { source: "n2", target: "n3" },
  { source: "n3", target: "n4" },
  { source: "n4", target: "n5" },
  { source: "n0", target: "n3" },
];

describe("forceLayout", () => {
  it("returns a finite position for every node", () => {
    const pos = forceLayout(IDS, EDGES, { collideW: 150, collideH: 50 });
    expect(pos.size).toBe(IDS.length);
    for (const id of IDS) {
      const p = pos.get(id);
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
  });
});

describe("layeredLayout", () => {
  it("returns finite positive bounds and a position per node", () => {
    const tierOf = new Map<string, number>([
      ["n0", 2],
      ["n1", 1],
      ["n2", 1],
      ["n3", 0],
    ]);
    const { pos, width, height } = layeredLayout(
      ["n0", "n1", "n2", "n3"],
      [
        { source: "n0", target: "n1" },
        { source: "n0", target: "n2" },
        { source: "n1", target: "n3" },
      ],
      tierOf,
      { w: 160, h: 60, hGap: 40, vGap: 60 }
    );
    expect(pos.size).toBe(4);
    for (const id of ["n0", "n1", "n2", "n3"]) {
      const p = pos.get(id);
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
    expect(Number.isFinite(width)).toBe(true);
    expect(Number.isFinite(height)).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});
