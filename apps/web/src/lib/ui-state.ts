"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * View state that has to outlive the component that shows it.
 *
 * Every section used to be a hidden `<div>` in one page, so a swarm run, a symbol
 * search or a timeline scrub survived switching sections for the dull reason that
 * nothing unmounted. Real routes unmount: navigating to Editor and back threw the
 * result away and put the "Run agent swarm" splash back, and a run that was still
 * in flight was abandoned mid-request.
 *
 * So the state moves OUT of the component. A module-scoped map is the store, a
 * per-key listener set is the notification, and `useSyncExternalStore` is the read
 * — the same shape the rail and the theme already use, for the same reason: the
 * value is genuinely external to any one mount. Long-running work then writes to
 * the store rather than to a component, which also removes the whole class of
 * "response lands after unmount" bugs — there is no unmounted setter to call.
 *
 * Lifetime is the page load. That is deliberate: a remediation plan is a snapshot
 * of a working tree, and resurrecting one from `sessionStorage` after a reload
 * would present a stale reading of a repository that may have moved underneath it.
 *
 * `initial` MUST be a stable value (a primitive, `null`, or a module constant).
 * A fresh object literal per render would make the snapshot change identity on
 * every read and spin `useSyncExternalStore`.
 */
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, onChange: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) listeners.delete(key);
  };
}

export function readState<T>(key: string, initial: T): T {
  return values.has(key) ? (values.get(key) as T) : initial;
}

/** Write from anywhere — including a promise continuation with no live component. */
export function writeState<T>(key: string, next: T): void {
  if (values.has(key) && values.get(key) === next) return;
  values.set(key, next);
  const set = listeners.get(key);
  if (set) for (const notify of [...set]) notify();
}

/** `useState`, except the state is keyed and survives unmount. */
export function useSharedState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const sub = useCallback((onChange: () => void) => subscribe(key, onChange), [key]);
  const get = useCallback(() => readState(key, initial), [key, initial]);
  const value = useSyncExternalStore(sub, get, get);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      writeState(
        key,
        typeof next === "function"
          ? (next as (prev: T) => T)(readState(key, initial))
          : next,
      );
    },
    [key, initial],
  );
  return [value, set];
}

/**
 * Run `work` at most once per key across the whole page.
 *
 * Two mounts of the same section (or a click, a navigation, and a click back)
 * would otherwise each fire the same expensive request; the second would also
 * clear the `loading` flag the first still needs.
 */
const inflight = new Map<string, Promise<void>>();

export function once(key: string, work: () => Promise<void>): Promise<void> {
  const running = inflight.get(key);
  if (running) return running;
  const p = work().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
