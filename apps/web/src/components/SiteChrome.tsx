"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useScroll } from "framer-motion";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Menu, X } from "lucide-react";
import { AuthNav } from "@/components/AuthNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useScrollSpring } from "@/components/motion/primitives";

const NAV = [
  { href: "/", label: "Index" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/fleet", label: "Fleet" },
  { href: "/settings", label: "Settings" },
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
      className={`sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-500 ${
        scrolled
          ? "border-b border-[var(--line)] bg-[rgba(6,8,10,0.72)] backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
      style={{ transitionTimingFunction: "var(--ease-out-expo)" }}
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
