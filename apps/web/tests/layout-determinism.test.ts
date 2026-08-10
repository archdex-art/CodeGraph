import { describe, expect, it } from "vitest";
import { forceLayout } from "@/lib/layout";

/**
 * A layout is a function of its input, and of nothing else.
 *
 * WHAT THIS PINS. `forceLayout` seeded its starting ring with `Math.random()`, so two calls
 * with identical ids and edges returned entirely different coordinates. Three things depended
 * on that not being true:
 *
 *   · Any re-render that changed the graph's identity re-ran the layout and sent EVERY node
 *     travelling somewhere new. The eased transition then drew cards sliding across and
 *     through each other — which is what a screenshot taken mid-flight shows as overlapping
 *     boxes. A stable layout has nothing to animate, so the transient cannot occur.
 *   · `GraphExport` writes a PNG of the view; two exports of one commit disagreed, which makes
 *     the image useless as evidence in a review.
 *   · A shared `?open=…&focus=…` link put the recipient on a differently-arranged graph.
 *
 * Order-invariance is asserted too, and separately: seeding alone did not buy it. Every
 * internal loop walks nodes by index and floating-point accumulation is not commutative, so
 * the same graph handed over in a different order still settled somewhere else — and every
 * caller builds its list from a `Map`, where an unrelated insertion reorders everything.
 */

const EDGES = [
  { source: "b", target: "a" },
  { source: "c", target: "b" },
  { source: "d", target: "a" },
];
const OPTS = { collideW: 156, collideH: 56 } as const;

/** A stable, comparable rendering of a layout. */
function fingerprint(ids: readonly string[], opts = OPTS): string {
  return [...forceLayout([...ids], EDGES, opts)]
    .map(([id, p]) => `${id}:${p.x.toFixed(4)},${p.y.toFixed(4)}`)
    .sort()
    .join("|");
}

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];

describe("forceLayout is reproducible", () => {
  it("returns identical positions for identical input", () => {
    expect(fingerprint(IDS)).toBe(fingerprint(IDS));
  });

  it("is stable across many repeats, not just two", () => {
    // A PRNG seeded from mutable module state would pass a single comparison and drift.
    const first = fingerprint(IDS);
    for (let i = 0; i < 5; i++) expect(fingerprint(IDS)).toBe(first);
  });

  it("does not depend on the order the ids arrive in", () => {
    const forward = fingerprint(IDS);
    expect(fingerprint([...IDS].reverse())).toBe(forward);
    expect(fingerprint(["c", "h", "a", "f", "b", "g", "d", "e"])).toBe(forward);
  });

  it("gives a DIFFERENT graph a different layout", () => {
    // The opposite failure: a constant seed that ignores the input would pass everything above
    // and pile unrelated graphs onto one arrangement.
    expect(fingerprint([...IDS, "z"])).not.toBe(fingerprint(IDS));
  });

  it("returns a position for every id it was given", () => {
    const pos = forceLayout([...IDS], EDGES, OPTS);
    expect(pos.size).toBe(IDS.length);
    for (const id of IDS) expect(pos.get(id)).toBeDefined();
  });
});

describe("forceLayout separates the cards it places", () => {
  /**
   * The reported symptom was overlapping cards. This asserts the settled layout never produces
   * one, across sizes and shapes — including the all-isolated case, which is what a repository
   * of loose root files (`README.md`, `ARCHITECTURE.md`, …) actually looks like.
   */
  const W = 156;
  const H = 56;

  const overlaps = (ids: string[], edges: typeof EDGES): number => {
    const pos = forceLayout(ids, edges, { collideW: W, collideH: H });
    let hits = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]!)!;
        const b = pos.get(ids[j]!)!;
        if (W - Math.abs(a.x - b.x) > 0.5 && H - Math.abs(a.y - b.y) > 0.5) hits++;
      }
    }
    return hits;
  };

  it.each([2, 3, 5, 9, 15, 30, 60])("leaves no overlap among %i isolated nodes", (n) => {
    expect(overlaps(Array.from({ length: n }, (_, i) => `n${i}`), [])).toBe(0);
  });

  it("leaves no overlap in a connected graph", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => ({ source: id, target: ids[i >> 1]! }));
    expect(overlaps(ids, edges)).toBe(0);
  });

  it("leaves no overlap when one node is an opened container many times the others", () => {
    // `sizeOf` is how NetworkView reserves room for an expanded module. Measured with the
    // COLLAPSED size, its neighbours land inside it.
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const big = { w: 900, h: 640 };
    const pos = forceLayout(ids, [], {
      collideW: W,
      collideH: H,
      sizeOf: (id) => (id === "n3" ? big : undefined),
    });
    let hits = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]!)!;
        const b = pos.get(ids[j]!)!;
        const hw = (ids[i] === "n3" ? big.w : W) / 2 + (ids[j] === "n3" ? big.w : W) / 2;
        const hh = (ids[i] === "n3" ? big.h : H) / 2 + (ids[j] === "n3" ? big.h : H) / 2;
        if (hw - Math.abs(a.x - b.x) > 0.5 && hh - Math.abs(a.y - b.y) > 0.5) hits++;
      }
    }
    expect(hits).toBe(0);
  });
});
