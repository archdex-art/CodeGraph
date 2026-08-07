import { describe, expect, it } from "vitest";
import {
  createWheelZoom,
  ZOOM_COALESCE_MS,
  ZOOM_DURATION_MS,
  ZOOM_STEP_RATIO,
} from "@/lib/zoom";

/**
 * The throttle is the whole point of this module, and it is invisible: without it
 * the zoom still "works" on a mouse and is unusable on a trackpad, which is exactly
 * the kind of regression nobody notices until a user complains. So the runaway case
 * is pinned numerically rather than described.
 */
describe("createWheelZoom", () => {
  it("zooms in on an upward tick and out on a downward one", () => {
    const zoom = createWheelZoom();
    expect(zoom({ deltaY: -100 }, 0)).toBeCloseTo(ZOOM_STEP_RATIO);
    // Opposite direction is always accepted, so this needs no clock advance.
    expect(zoom({ deltaY: 100 }, 0)).toBeCloseTo(1 / ZOOM_STEP_RATIO);
  });

  it("ignores the magnitude of deltaY", () => {
    // A trackpad reports single-digit deltas and a mouse reports ~100 for the same
    // intent; honouring magnitude would make the zoom device-dependent.
    const a = createWheelZoom();
    const b = createWheelZoom();
    expect(a({ deltaY: -4 }, 0)).toBe(b({ deltaY: -240 }, 0));
  });

  it("ignores a zero delta rather than treating it as a direction", () => {
    expect(createWheelZoom()({ deltaY: 0 }, 0)).toBeNull();
  });

  it("drops same-direction ticks inside the coalesce window", () => {
    const zoom = createWheelZoom();
    expect(zoom({ deltaY: -100 }, 1000)).not.toBeNull();
    expect(zoom({ deltaY: -100 }, 1000 + ZOOM_COALESCE_MS - 1)).toBeNull();
    expect(zoom({ deltaY: -100 }, 1000 + ZOOM_COALESCE_MS)).not.toBeNull();
  });

  it("accepts a reversal immediately, so an overshoot can be corrected", () => {
    const zoom = createWheelZoom();
    expect(zoom({ deltaY: -100 }, 0)).not.toBeNull();
    // Same instant, opposite direction: honoured, because correcting an overshoot
    // is the moment a user is least tolerant of lag.
    expect(zoom({ deltaY: 100 }, 0)).toBeCloseTo(1 / ZOOM_STEP_RATIO);
  });

  it("keeps a trackpad's event storm to a survivable number of steps", () => {
    // One second of a real trackpad flick: ~60 events, all one direction.
    const zoom = createWheelZoom();
    let accepted = 0;
    let scale = 1;
    for (let ms = 0; ms < 1000; ms += 1000 / 60) {
      const f = zoom({ deltaY: -4 }, ms);
      if (f !== null) {
        accepted++;
        scale *= f;
      }
    }
    // Throttled to one per coalesce window, not one per event.
    expect(accepted).toBeLessThanOrEqual(Math.ceil(1000 / ZOOM_COALESCE_MS));
    expect(accepted).toBeGreaterThan(1);
    // The bug this replaced: 60 unthrottled ticks compounded past 10^3. A second of
    // scrolling should cross a usable range, not the entire number line.
    expect(scale).toBeLessThan(100);
  });

  it("throttles independently per surface", () => {
    // Two graphs on one page must not starve each other's wheel handling.
    const a = createWheelZoom();
    const b = createWheelZoom();
    expect(a({ deltaY: -100 }, 0)).not.toBeNull();
    expect(b({ deltaY: -100 }, 0)).not.toBeNull();
  });

  it("keeps the coalesce window shorter than the animation, so ticks overlap", () => {
    // The invariant is the RELATIONSHIP, not the value: a window longer than the
    // animation produces a staircase, and overlap is what makes a continuous scroll
    // read as one continuous ramp.
    expect(ZOOM_COALESCE_MS).toBeLessThan(ZOOM_DURATION_MS);
  });

  it("takes about a second of scrolling to cross a 40x range", () => {
    // Sized against the clamp the surfaces actually use. Faster than this and one
    // trackpad flick slams into the stop, which was the original complaint.
    const ticksToCross = Math.log(40) / Math.log(ZOOM_STEP_RATIO);
    const seconds = (ticksToCross * ZOOM_COALESCE_MS) / 1000;
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(2);
  });
});
