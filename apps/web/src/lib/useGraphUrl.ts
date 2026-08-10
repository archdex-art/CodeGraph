"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { graphHref, parseGraphState, type GraphUrlState } from "./graph-url";

/**
 * A graph view's state, held in the query string instead of in `useState`.
 *
 * `replace`, never `push`. Opening a module, searching, zooming a directory — these
 * are twenty micro-adjustments per visit, and pushing each one turns Back into an
 * undo stack for hovering. Replacing keeps Back meaning "leave this page", which is
 * what a Back button on a canvas is for.
 *
 * `scroll: false` because the default scrolls to the top of the document on every
 * navigation, and an immersive canvas that jumps each time you open a box is worse
 * than no deep link at all.
 *
 * `enabled` exists for the one embedded case: `CirclePackView` is also drawn inside
 * the timeline scrubber, where the circle you zoomed is a detail of a snapshot, not
 * the page's state — writing it to the URL there would have two surfaces fighting
 * over one param.
 */
export function useGraphUrl(enabled = true): [GraphUrlState, (next: GraphUrlState) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const set = useCallback(
    (next: GraphUrlState) => {
      if (!enabled) return;
      router.replace(graphHref(pathname, search, next), { scroll: false });
    },
    [enabled, pathname, router, search]
  );

  return [enabled ? parseGraphState(search) : { open: null, focus: null }, set];
}
