"use client";

/**
 * Motion primitives.
 *
 * Every animation on the marketing surface goes through one of these, for one
 * reason: `useReducedMotion` has to be honoured in every single one, and the
 * way that gets missed is by hand-rolling a `motion.div` in the ninth section
 * at 2am. Centralising it means the OS setting is respected by construction
 * rather than by discipline.
 *
 * The CSS in `globals.css` disables keyframe animations under the same media
 * query; this covers the JS-driven half.
 */

import {
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionProps,
  type Variants,
} from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Expo-out, matching `--ease-out-expo`. Leaves fast, arrives slow. */
const EASE = [0.16, 1, 0.3, 1] as const;

/* -------------------------------------------------------------------------- */

/**
 * Reveal on scroll.
 *
 * `once` is the default and it is deliberate: an element that re-animates every
 * time it re-enters the viewport turns scrolling back up into a light show, and
 * on a long page it reads as a bug rather than a flourish.
 */
export function Reveal({
  children,
  delay = 0,
  y = 18,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  as?: "div" | "section" | "li" | "span";
}) {
  const reduced = useReducedMotion();
  const Tag = motion[as] as typeof motion.div;

  return (
    <Tag
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-12% 0px -8% 0px" }}
      transition={{ duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </Tag>
  );
}

/**
 * Entrance on mount — for content that is ALREADY in the viewport when the page
 * loads.
 *
 * `Reveal` below is scroll-triggered, and using it above the fold is a race it
 * can lose: the element never crosses an intersection boundary because it was
 * never outside one, so whether the observer reports it depends on when the
 * callback lands relative to hydration. Observed failing on a 390px viewport
 * while passing at 1440px — the hero simply did not appear, stuck at
 * `opacity: 0` with no error anywhere.
 *
 * The distinction is not a workaround, it is the correct one: hero content
 * animates because the page arrived, not because you scrolled to it.
 */
export function Entrance({
  children,
  delay = 0,
  y = 18,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Stagger container. Children opt in with `<StaggerItem>`.
 *
 * The delay between children is small (60ms) on purpose — a stagger you can
 * count is a stagger that is too slow.
 */
export function Stagger({
  children,
  className,
  delay = 0,
  step = 0.06,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  step?: number;
}) {
  const reduced = useReducedMotion();
  const variants: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : step, delayChildren: delay } },
  };

  return (
    <motion.div
      className={className}
      variants={variants}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-10% 0px" }}
    >
      {children}
    </motion.div>
  );
}

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};

export function StaggerItem({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & MotionProps) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      variants={reduced ? undefined : staggerItem}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Count a number up when it scrolls into view.
 *
 * Renders the FINAL value on the server and for reduced-motion, so the figure
 * is correct in the DOM before any JS runs. A counter that starts at zero in
 * the markup is a counter that reads "0" to a crawler and to anyone whose JS
 * failed — for a page whose whole argument is its numbers, that is the one
 * failure mode worth engineering around.
 */
export function CountUp({
  to,
  decimals = 0,
  duration = 1.4,
  prefix = "",
  suffix = "",
  className,
}: {
  to: number;
  decimals?: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-15% 0px" });
  const [display, setDisplay] = useState(() => to);

  useEffect(() => {
    if (reduced || !inView) return;
    let raf = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / (duration * 1000));
      // Same expo-out curve as everything else, so the number decelerates the
      // way the panels it sits in do.
      const eased = 1 - Math.pow(2, -10 * t);
      setDisplay(to * (t === 1 ? 1 : eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    // No synchronous reset to 0 here: the first animation frame writes t≈0 anyway,
    // so setting it in the effect body only bought an extra render — and an extra
    // render that paints "0" is exactly the flash this component exists to avoid.
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduced, to, duration]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Magnetic hover: the element leans toward the cursor.
 *
 * Bounded to `strength` px and spring-damped, because the version of this
 * effect that follows the pointer freely feels broken rather than responsive.
 * Disabled entirely for reduced-motion and never applied on touch, where there
 * is no cursor to lean toward and the transform just fights the tap.
 */
export function Magnetic({
  children,
  strength = 6,
  className,
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const x = useSpring(mx, { stiffness: 220, damping: 18, mass: 0.4 });
  const y = useSpring(my, { stiffness: 220, damping: 18, mass: 0.4 });

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div
      ref={ref}
      className={className}
      style={{ x, y }}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        mx.set(((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * strength);
        my.set(((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * strength);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Progress rail for the sticky header — a hairline that fills with scroll depth.
 *
 * Driven by `scrollYProgress` through a spring so it does not judder on
 * trackpads that emit high-frequency deltas.
 */
export function useScrollSpring(progress: import("framer-motion").MotionValue<number>) {
  return useSpring(progress, { stiffness: 120, damping: 28, restDelta: 0.001 });
}

/** Parallax helper: maps scroll progress to a bounded pixel offset. */
export function useParallax(
  progress: import("framer-motion").MotionValue<number>,
  distance: number
) {
  const reduced = useReducedMotion();
  return useTransform(progress, [0, 1], [0, reduced ? 0 : distance]);
}
