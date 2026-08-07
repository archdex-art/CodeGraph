// Wheel-zoom policy, shared by every pannable/zoomable surface.
//
// Modelled on Sigma's `MouseCaptor`, which is what makes graph tools that use it
// feel calm under a trackpad. Three mechanisms do the work, and we previously had
// none of them:
//
//  1. A wheel tick is a REQUEST, animated over `ZOOM_DURATION_MS`, not a jump
//     applied on the spot. Applying instantly turns a scroll into a staircase.
//  2. Same-direction ticks inside `ZOOM_COALESCE_MS` are DROPPED. This is the one
//     that matters: a trackpad emits ~60 wheel events per second, and multiplying
//     the scale by a step on each one compounds to an absurd factor within a
//     second. Rate-limiting the *decisions* is what makes a trackpad controllable.
//  3. The step is a fixed ratio and the delta is read for its SIGN only. Scaling
//     the step by `deltaY` sounds more faithful but is not portable: the same
//     physical gesture reports ~4px on a trackpad, 100px on a mouse in Chrome and
//     3 lines in Firefox, so honouring magnitude makes the zoom device-dependent.

/**
 * Scale multiplier per accepted tick. Sigma defaults to 1.7, tuned for its
 * 0.002–50 camera range; across our ~40x span that would cross the whole range in
 * seven ticks. 1.5 gives roughly nine, which still moves decisively without
 * overshooting the level you were aiming for.
 */
export const ZOOM_STEP_RATIO = 1.5;

/** How long one accepted tick takes to play out. */
export const ZOOM_DURATION_MS = 250;

/** Programmatic zoom (the +/- buttons) — shorter, because you asked for exactly one step. */
export const ZOOM_BUTTON_DURATION_MS = 200;

/**
 * Minimum spacing between accepted ticks in the same direction.
 *
 * Sigma uses a fifth of the animation duration (50ms), and that is right for its
 * 0.002–50 camera range: 25,000x takes a long time to cross even at twenty ticks a
 * second. Our surfaces clamp to about 40x, which the same setting crosses in under
 * half a second — so a single trackpad flick still slammed into the stop, which is
 * the complaint this module exists to answer.
 *
 * Derived from the range instead: ~9 ticks of `ZOOM_STEP_RATIO` span 40x, and 130ms
 * spaces those over roughly 1.2 seconds of continuous scrolling. Still comfortably
 * under `ZOOM_DURATION_MS`, so consecutive animations overlap and the motion stays
 * a ramp rather than a staircase — that relationship is the invariant, not the
 * exact fraction.
 */
export const ZOOM_COALESCE_MS = 130;

/**
 * Stateful wheel-to-zoom-factor reducer. Returns the multiplier to apply to the
 * current scale, or `null` when the tick should be ignored.
 *
 * The state is the last accepted direction and time, which is why this is a closure
 * per surface rather than a pure function: two graphs on one page must throttle
 * independently. `now` is injectable so the policy is testable without a clock.
 */
export function createWheelZoom(): (e: { deltaY: number }, now?: number) => number | null {
  let lastDirection = 0;
  let lastAcceptedAt = 0;

  return (e, now = Date.now()) => {
    if (!e.deltaY) return null;
    // Up/away from the user zooms in. Magnitude is deliberately discarded — see above.
    const direction = e.deltaY < 0 ? 1 : -1;

    // A REVERSAL is always honoured immediately: correcting an overshoot is the one
    // moment a user is most sensitive to lag, and it cannot run away because the
    // next tick back the other way re-arms the throttle.
    if (direction === lastDirection && now - lastAcceptedAt < ZOOM_COALESCE_MS) return null;

    lastDirection = direction;
    lastAcceptedAt = now;
    return direction === 1 ? ZOOM_STEP_RATIO : 1 / ZOOM_STEP_RATIO;
  };
}
