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

describe("forceLayout sizeOf", () => {
  /**
   * A module opened in the network view claims the room its revealed files occupy.
   * Separating it from its neighbours by a COLLAPSED box's width is what put those
   * files on top of the modules beside it.
   */
  const BIG = { w: 900, h: 700 };

  it("keeps an oversized node clear of every other node", () => {
    const pos = forceLayout(IDS, EDGES, {
      collideW: 150,
      collideH: 50,
      sizeOf: (id) => (id === "n0" ? BIG : undefined),
    });
    const big = pos.get("n0")!;
    for (const id of IDS.filter((i) => i !== "n0")) {
      const p = pos.get(id)!;
      const gapX = Math.abs(p.x - big.x) - (BIG.w + 150) / 2;
      const gapY = Math.abs(p.y - big.y) - (BIG.h + 50) / 2;
      expect(gapX > -1 || gapY > -1).toBe(true);
    }
  });

  it("leaves default-sized nodes on the default spacing", () => {
    // Positions are seeded randomly, so the property — not the coordinates — is what
    // can be asserted: with no override, every pair is still separated by the box.
    const pos = forceLayout(IDS, EDGES, { collideW: 150, collideH: 50, sizeOf: () => undefined });
    for (const a of IDS) {
      for (const b of IDS) {
        if (a >= b) continue;
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        const clearX = Math.abs(pa.x - pb.x) >= 150 - 1;
        const clearY = Math.abs(pa.y - pb.y) >= 50 - 1;
        expect(clearX || clearY).toBe(true);
      }
    }
  });
});
