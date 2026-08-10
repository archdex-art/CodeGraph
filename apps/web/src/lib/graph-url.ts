/**
 * The part of a graph view's state that belongs in its URL.
 *
 * A visualisation nobody can share is a toy: you find the one module whose imports
 * explain the bug, and the only way to show a colleague is a screenshot. These two
 * functions are the whole contract — every graph view reflects its state through
 * them, so a pasted link lands on the same picture the sender was looking at.
 *
 * Kept free of React and of `next/navigation` on purpose: the round-trip is the part
 * that has to be right, and it is testable only while it stays a pure string
 * transformation. The hook that wires it to the router lives in `useGraphUrl.ts`.
 */

/** Network: the open module. Architecture: the expanded module. Circle pack: the zoomed directory. */
export const OPEN_PARAM = "open";
/** The node the camera is parked on — a search landing, or the box you drilled into. */
export const FOCUS_PARAM = "focus";

/**
 * `open=all` means every module at once.
 *
 * A top-level directory literally named `all` would be read as the sentinel. That is
 * the price of a link a human can retype; the alternative sentinels (`*`, `__all__`)
 * buy an unlikely collision back at the cost of every URL that does not collide.
 */
export const ALL_MODULES = "all";

export interface GraphUrlState {
  open: string | null;
  focus: string | null;
}

/** `useSearchParams()` hands back a readonly variant, so only the read surface is required. */
type ReadableParams = Pick<URLSearchParams, "get" | "toString">;

export function parseGraphState(query: ReadableParams | string): GraphUrlState {
  const p = new URLSearchParams(typeof query === "string" ? query : query.toString());
  // `|| null` rather than the raw result: `?open=` is a user deleting the value, not
  // a request to open the module whose id is the empty string.
  return { open: p.get(OPEN_PARAM) || null, focus: p.get(FOCUS_PARAM) || null };
}

/**
 * `state` written over `query`, preserving every param this module does not own.
 *
 * Returns a query string without the leading `?`; empty when nothing is left, so a
 * default view gets a clean URL instead of a trailing `?`.
 */
export function serialiseGraphState(query: ReadableParams | string, state: GraphUrlState): string {
  const p = new URLSearchParams(typeof query === "string" ? query : query.toString());
  for (const [key, value] of [
    [OPEN_PARAM, state.open],
    [FOCUS_PARAM, state.focus],
  ] as const) {
    if (value) p.set(key, value);
    else p.delete(key);
  }
  return p.toString();
}

/** The href to hand `router.replace` — `pathname` alone when the state is the default. */
export function graphHref(pathname: string, query: ReadableParams | string, state: GraphUrlState): string {
  const qs = serialiseGraphState(query, state);
  return qs ? `${pathname}?${qs}` : pathname;
}
