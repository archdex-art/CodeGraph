"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Crosshair, X } from "lucide-react";
import { CodeIntelPanel } from "@/components/CodeIntelPanel";
import { useSharedState } from "@/lib/ui-state";
import type { SymbolGraph } from "@/lib/types";

/**
 * A graph view and the symbol inspector for whatever you clicked in it.
 *
 * These used to be two routes. You looked at the import network, saw an interesting
 * box, then navigated to a separate "Code intel" page and re-found the same node by
 * typing its name — re-finding by keyboard what you had already found by eye. Worse,
 * that page's own empty state read "Select a symbol", and it had nothing to select
 * from. The two halves were each other's missing piece.
 *
 * The selection lives in the shared store rather than local state, so moving between
 * Architecture, Circle pack and Network keeps the thing you were looking at. It is
 * keyed by repository: two repos open in two tabs do not share a cursor.
 *
 * `immersive` mode renders the inspector as a floating sheet with three states —
 * open, minimised to a title bar, and dismissed — reachable from a summon button
 * that sits beside the canvas search.
 */

/**
 * One spring, used for every transition on this surface.
 *
 * Tuned rather than picked: `stiffness/damping` at this ratio is very slightly
 * under-damped, so a panel settles with a single hairline overshoot instead of
 * decelerating into place — which is the difference between "animated" and the
 * physical feel iOS gets. `mass` above 1 keeps a 420px sheet from snapping like a
 * tooltip. A `tween` with an ease curve cannot do this: interrupt it halfway and it
 * restarts from a stale value, whereas a spring re-targets from its CURRENT
 * position and velocity — which is what makes rapid minimise/restore clicks track
 * the pointer instead of stuttering.
 */
const SPRING = { type: "spring" as const, stiffness: 420, damping: 36, mass: 1.1 };

/** Opacity has no momentum to preserve, so it rides a short tween and gets out of the way. */
const FADE = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };

type PanelState = "open" | "minimized" | "closed";

export function GraphWorkbench({
  repoId,
  graph,
  children,
  immersive = false,
}: {
  repoId: string;
  graph: SymbolGraph | null | undefined;
  /** Renders the graph. Hand the callback to whichever view emits node ids. */
  children: (onSelect: (id: string | null) => void) => React.ReactNode;
  /** Full-bleed canvas mode: panel floats instead of stacking below. */
  immersive?: boolean;
}) {
  const [scope, setScope] = useSharedState<string | null>(
    `intel:${repoId}:scope`,
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const lastScope = useRef(scope);

  /**
   * Panel state is SHARED, not local: it is keyed by repo and survives moving between
   * Architecture and Network. Minimising the inspector on one graph and finding it
   * expanded again on the next is the kind of state loss that makes a tool feel like
   * a set of pages rather than one instrument.
   */
  const [panelState, setPanelState] = useSharedState<PanelState>(
    `intel:${repoId}:panelState`,
    "open",
  );

  const reducedMotion = useReducedMotion();
  const spring = reducedMotion ? { duration: 0 } : SPRING;

  /**
   * A fresh selection re-opens a dismissed panel: clicking a node and having nothing
   * happen because the inspector was closed ten minutes ago reads as a dead click.
   * A MINIMISED panel is left alone — that state is a deliberate "keep it out of the
   * way", and overriding it would make the minimise button feel like it does not
   * stick.
   */
  useEffect(() => {
    const entering = scope !== null && lastScope.current === null;
    lastScope.current = scope;
    if (!immersive && entering)
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (immersive && entering) setPanelState((s) => (s === "closed" ? "open" : s));
  }, [scope, immersive, setPanelState]);

  const clear = useCallback(() => setScope(null), [setScope]);

  const hasIntel = graph && graph.symbols.length > 0 && scope !== null;

  if (immersive) {
    return (
      <div className="relative h-full w-full">
        {children(setScope)}

        {/* Summon button. Sits in the canvas's top-left cluster beside the search so
            the two controls that OPEN something live together. It is only offered
            when there is something to summon — a button that reveals an empty panel
            is a button that does nothing.

            Positioned off the SAME tokens the views use for their search bar
            (`left-md` + `w-64`), so the two stay adjacent without either component
            importing the other's layout. A hardcoded pixel offset here would drift
            the moment a view changed its search width. */}
        <AnimatePresence>
          {hasIntel && panelState !== "open" && (
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={spring}
              onClick={() => setPanelState("open")}
              title="Show symbol inspector"
              aria-label="Show symbol inspector"
              className="absolute left-[calc(var(--space-md)+16rem+var(--space-sm))] top-md z-10 flex h-9 cursor-pointer items-center gap-xs rounded-lg border border-[var(--line)] bg-[var(--surface-1)]/95 px-sm text-meta text-[var(--text-secondary)] shadow-lg backdrop-blur-md transition-colors hover:border-[var(--line-strong)] hover:text-[var(--text-primary)]"
            >
              <Crosshair className="h-3.5 w-3.5 shrink-0 text-[var(--violet-text)]" />
              <span className="whitespace-nowrap">Inspector</span>
            </motion.button>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {hasIntel && panelState !== "closed" && (
            <motion.div
              /* Height has exactly ONE owner: this element's own `animate.height`.

                 The obvious build — `layout` on the sheet plus a CSS height — has two.
                 Measured, that collapse ran 772 → 969 → 1093 → 38px: the layout engine
                 projected the pre-collapse box while CSS was already shrinking it, so
                 the sheet ballooned past the viewport for two frames before snapping.
                 Animating the value directly means the spring interpolates one number
                 from one source, and the top edge never moves because the box is
                 anchored at `top` and grows downward only.

                 `100dvh` minus the chrome and the two gutters is the open height — the
                 canvas is exactly that tall, and resolving it here rather than from a
                 `bottom` pin is what keeps a single anchor. */
              initial={{ opacity: 0, x: 24, scale: 0.97 }}
              animate={{
                opacity: 1,
                x: 0,
                scale: 1,
                height:
                  panelState === "open"
                    ? "calc(100dvh - var(--header-h) - 1.5rem - 2 * var(--space-md))"
                    : "2.4rem",
              }}
              exit={{ opacity: 0, x: 24, scale: 0.97 }}
              transition={spring}
              className={`absolute right-md top-md z-10 flex w-[420px] min-w-[320px] max-w-[50vw] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-1)]/95 shadow-2xl backdrop-blur-md ${
                panelState === "open" ? "resize-x" : ""
              }`}
            >
              {/* Title bar. `shrink-0` is load-bearing: it is the one row that must
                  survive the collapse, so it must never be the thing flex shrinks to
                  make the box fit. It is a plain element — the parent animates its own
                  height, so there is no sibling layout for this row to coordinate with. */}
              <div className="flex shrink-0 items-center justify-between gap-sm border-b border-[var(--line)] px-sm py-xs">
                <span className="truncate text-micro font-medium text-[var(--text-secondary)]">
                  Symbol Inspector
                </span>
                <div className="flex shrink-0 items-center gap-2xs">
                  <button
                    type="button"
                    onClick={() =>
                      setPanelState((s) => (s === "open" ? "minimized" : "open"))
                    }
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
                    aria-label={panelState === "open" ? "Minimize" : "Expand"}
                    title={panelState === "open" ? "Minimize" : "Expand"}
                  >
                    {/* Rotation rather than an icon swap — a glyph that turns reads as
                        the same control changing state; two glyphs read as two buttons. */}
                    <motion.span
                      animate={{ rotate: panelState === "open" ? 0 : 180 }}
                      transition={spring}
                      className="flex"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </motion.span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanelState("closed")}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
                    aria-label="Close inspector"
                    title="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <AnimatePresence initial={false}>
                {panelState === "open" && (
                  <motion.div
                    key="body"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={FADE}
                    /* `@container`: every responsive rule inside the panel measures
                       THIS box, not the window — the sheet is drag-resizable down to
                       320px while the viewport stays 1568px wide, and a viewport
                       query would keep a two-column split in a track that can no
                       longer hold one.

                       `px-sm` is not decoration: it is the SAME inset the title bar
                       above uses, so the stats row lines up with "Symbol Inspector"
                       instead of starting 10px further left and running into the
                       panel's own edge. `CodeIntelPanel` carries no padding of its
                       own because in the stacked layout the page column provides it —
                       so the floating shell has to. */
                    className="split-host @container min-h-0 flex-1 overflow-y-auto px-sm pb-sm"
                  >
                    <CodeIntelPanel
                      repoId={repoId}
                      graph={graph}
                      scope={scope}
                      onClearScope={clear}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // Standard stacked layout
  return (
    <>
      {children(setScope)}
      {graph && graph.symbols.length > 0 && (
        <div ref={panelRef} className="@container mt-xl scroll-mt-2xl">
          <div className="mb-md h-px bg-[var(--line)]" />
          <CodeIntelPanel
            repoId={repoId}
            graph={graph}
            scope={scope}
            onClearScope={clear}
          />
        </div>
      )}
    </>
  );
}
