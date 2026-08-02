import { describe, it, expect } from "vitest";
import { sanitizeBounds, DEFAULT_BOUNDS, Display } from "./window-state";

const PRIMARY: Display = { x: 0, y: 0, width: 1920, height: 1080 };

describe("sanitizeBounds", () => {
  it("returns defaults when bounds are missing", () => {
    expect(sanitizeBounds(null, [PRIMARY])).toEqual(DEFAULT_BOUNDS);
    expect(sanitizeBounds({}, [PRIMARY])).toEqual(DEFAULT_BOUNDS);
  });

  it("returns defaults when width/height are non-numeric", () => {
    expect(sanitizeBounds({ width: "big" as unknown as number, height: 700 }, [PRIMARY])).toEqual(
      DEFAULT_BOUNDS
    );
  });

  it("clamps below-minimum dimensions up to the minimum", () => {
    const out = sanitizeBounds({ width: 100, height: 100 }, [PRIMARY]);
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
  });

  it("preserves a valid on-screen position", () => {
    const out = sanitizeBounds({ width: 1000, height: 700, x: 200, y: 150 }, [PRIMARY]);
    expect(out).toEqual({ width: 1000, height: 700, x: 200, y: 150 });
  });

  it("drops an off-screen position but keeps the size", () => {
    const out = sanitizeBounds({ width: 1000, height: 700, x: 9000, y: 9000 }, [PRIMARY]);
    expect(out).toEqual({ width: 1000, height: 700 });
    expect(out.x).toBeUndefined();
  });

  it("keeps a position that lands on a secondary display", () => {
    const secondary: Display = { x: 1920, y: 0, width: 1920, height: 1080 };
    const out = sanitizeBounds({ width: 1000, height: 700, x: 2200, y: 100 }, [PRIMARY, secondary]);
    expect(out).toEqual({ width: 1000, height: 700, x: 2200, y: 100 });
  });

  it("omits position when only x or only y is provided", () => {
    const out = sanitizeBounds({ width: 1000, height: 700, x: 200 }, [PRIMARY]);
    expect(out).toEqual({ width: 1000, height: 700 });
  });
});
