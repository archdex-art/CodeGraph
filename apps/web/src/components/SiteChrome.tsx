"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion, useScroll } from "framer-motion";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Menu, X } from "lucide-react";
import { AuthNav } from "@/components/AuthNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useScrollSpring } from "@/components/motion/primitives";

/*
 * `Settings` is deliberately absent. The page held exactly two sections - "Claude AI
 * Assistant" and "Local Model (OpenAI-Compatible)" - and went with them when the product
 * became LLM-free. There is nothing else configurable per account, so a nav entry here would
 * link to a 404; when something genuinely per-account arrives, this is where it goes back.
 */
const NAV = [
  { href: "/", label: "Index" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/fleet", label: "Fleet" },
];

/**
 * The instrument mark: three nodes and the two edges between them, which is the
 * smallest drawing that is still a graph. The centre node carries the signal
 * colour because the centre node is the one the score is about.
 */
function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M6 17.5 12 7l6 10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.45" />
      <circle cx="6" cy="17.5" r="2.1" fill="currentColor" opacity="0.55" />
      <circle cx="18" cy="17.5" r="2.1" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="7" r="2.9" fill="var(--signal-500)" />
    </svg>
  );
}

/**
 * How far you must be down the page before the header will retract at all. Below
 * this the header is transparent anyway, so retracting it would animate something
 * nobody can see and then animate it back.
 */
const RETRACT_AFTER = 160;

/**
 * Movement smaller than this is not a decision. Trackpad inertia and the 1–2px
 * jitter a sticky sub-header produces when it settles would otherwise flip the
 * direction every frame and strobe the chrome.
 */
const DIRECTION_NOISE = 6;

/**
 * Scroll DIRECTION, as an external store.
 *
 * Direction is not a function of the current scroll position, so unlike `scrolled`
 * it cannot be derived in `getSnapshot` — it needs the previous position, which
 * lives in this closure rather than in React state. The store still satisfies
 * `useSyncExternalStore`'s contract: `get()` returns a cached boolean that only
 * changes when subscribers are notified, never a fresh object per call.
 */
function createRetractStore() {
  let retracted = false;
  let lastY = 0;
  const listeners = new Set<() => void>();

  const set = (v: boolean) => {
    if (v === retracted) return;
    retracted = v;
    for (const l of listeners) l();
  };

  const onScroll = () => {
    const y = window.scrollY;
    const dy = y - lastY;
    if (Math.abs(dy) < DIRECTION_NOISE) return;
    lastY = y;
    // Scrolling UP always returns the chrome, at any depth — the whole point is
    // that reaching for navigation is one flick, not a trip to the top of the page.
    set(dy > 0 && y > RETRACT_AFTER);
  };

  return {
    subscribe(cb: () => void) {
      if (listeners.size === 0) {
        lastY = window.scrollY;
        window.addEventListener("scroll", onScroll, { passive: true });
      }
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) window.removeEventListener("scroll", onScroll);
      };
    },
    get: () => retracted,
    reveal: () => set(false),
  };
}

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { scrollYProgress } = useScroll();
  const rail = useScrollSpring(scrollYProgress);

  /**
   * Scroll position is external browser state, so it is SUBSCRIBED to rather than
   * mirrored into React state from an effect. That also fixes a real case the effect
   * version got wrong: reloading already scrolled down rendered a transparent header
   * for one frame before the effect corrected it.
   *
   * The third argument is the server snapshot — `false`, because on the server there
   * is no scroll and the markup must match the client's first paint.
   */
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("scroll", cb, { passive: true });
    return () => window.removeEventListener("scroll", cb);
  }, []);
  const scrolled = useSyncExternalStore(
    subscribe,
    () => window.scrollY > 8,
    () => false
  );

  /**
   * The chrome yields to the content.
   *
   * A 70px bar across a 863px laptop viewport is 8% of the reading area, held
   * permanently for four links you use a handful of times per session. So it
   * retracts as you read down and returns the instant you scroll up — the cost of
   * reaching navigation drops from "scroll to the top" to "one flick", and the
   * cost of reading drops to nothing.
   *
   * Three cases keep it pinned, because in each of them retracting would be a
   * malfunction rather than a courtesy:
   *  · the mobile sheet is open — the header IS the open menu;
   *  · focus is inside it — a keyboard user tabbing the nav must not be shown a
   *    bar sliding away under their own caret;
   *  · `prefers-reduced-motion` — for anyone who asked for less movement, chrome
   *    that comes and goes on every scroll is the exact thing they turned off.
   */
  const retractStore = useMemo(() => createRetractStore(), []);
  const scrollRetracted = useSyncExternalStore(retractStore.subscribe, retractStore.get, () => false);
  const [focusWithin, setFocusWithin] = useState(false);
  const reducedMotion = useReducedMotion();
  const retracted = scrollRetracted && !open && !focusWithin && !reducedMotion;

  /**
   * A route change with the sheet still open leaves it covering the new page.
   *
   * Adjusted DURING RENDER rather than in an effect — React's documented pattern for
   * "reset state when an input changes". An effect would paint the new route with the
   * old sheet still over it for one frame before correcting.
   */
  const [sheetRoute, setSheetRoute] = useState(pathname);
  if (sheetRoute !== pathname) {
    setSheetRoute(pathname);
    if (open) setOpen(false);
  }

  return (
    <header
      data-retracted={retracted}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={() => setFocusWithin(false)}
      className={`sticky top-0 transition-[background-color,border-color,backdrop-filter,transform] duration-500 ${
        retracted ? "-translate-y-full" : "translate-y-0"
      } ${
        scrolled
          ? /* `--surface-0`, not a literal ink: the old `rgba(6,8,10,0.72)` was the dark
               page colour hardcoded, so on paper the header turned into a charcoal slab
               over white content the moment you scrolled. Matches the mobile sheet below. */
            "border-b border-[var(--line)] bg-[var(--surface-0)]/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
      style={{ zIndex: "var(--z-header)", transitionTimingFunction: "var(--ease-out-expo)" }}
    >
      <div className="shell flex h-2xl items-center justify-between">
        <Link
          href="/"
          className="group flex items-center gap-sm text-body font-medium tracking-tight text-[var(--text-primary)]"
        >
          <Mark className="h-[22px] w-[22px] text-[var(--text-secondary)] transition-transform duration-500 group-hover:scale-110" />
          CodeGraph
        </Link>

        <nav className="hidden items-center gap-2xs md:flex">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="relative rounded-lg px-sm py-xs text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--text-primary)]"
              >
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-lg bg-[var(--surface-active)] ring-1 ring-[var(--line)]"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
                <span className="relative">{item.label}</span>
              </Link>
            );
          })}
          <div className="ml-sm flex items-center gap-sm border-l border-[var(--line)] pl-sm">
            <ThemeToggle />
            <AuthNav />
          </div>
        </nav>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Scroll depth. A hairline rather than a bar — it is orientation, not a
          statistic, and it should be findable without being looked at. */}
      <motion.div
        className="h-px origin-left bg-[var(--signal-500)]"
        style={{ scaleX: rail, opacity: scrolled ? 0.85 : 0 }}
      />

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-[var(--line)] bg-[var(--surface-0)]/95 backdrop-blur-xl md:hidden"
          >
            <div className="flex flex-col gap-2xs px-lg py-md">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex min-h-11 items-center rounded-lg px-sm text-body text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  {item.label}
                </Link>
              ))}
              <div className="mt-sm flex items-center justify-between gap-sm border-t border-[var(--line)] pt-sm">
                <AuthNav />
                <ThemeToggle />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="relative mt-3xl border-t border-[var(--line)]">
      <div className="shell py-xl">
        <div className="flex flex-col gap-lg sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-sm">
            <Mark className="h-5 w-5 text-[var(--text-muted)]" />
            <span className="text-meta text-[var(--text-secondary)]">CodeGraph</span>
            <span className="eyebrow ml-2xs">MIT</span>
          </div>
          <p className="max-w-note text-meta text-[var(--text-muted)]">
            One container. One SQLite file. No API key. Every number on this page was
            measured on a real repository, and the commands that measure it are in the repo.
          </p>
        </div>
      </div>
    </footer>
  );
}
