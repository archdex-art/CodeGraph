"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/** A subscription that never notifies — the snapshot below flips once, at hydration. */
const NEVER_CHANGES = () => () => {};

/**
 * A dialog that is guaranteed to cover the chrome.
 *
 * z-index only ranks siblings inside one stacking context, and `<main>` is a
 * stacking context (`z-2`, which it carries to clear the grain layer). So a modal
 * rendered inside a page could write `z-50` and still paint UNDER the `z-50`
 * header, because the two numbers were never compared: `main`'s entire subtree is
 * ranked as a single "2" against the header's "50". The symptom was a full-screen
 * diff with the nav bar sitting across its title bar.
 *
 * Raising the number would not have fixed it — no value inside `main` can exceed
 * `main`. Escaping the context is the fix, so this portals to `<body>`, where the
 * `--z-*` scale is finally meaningful.
 *
 * Everything a dialog owes the keyboard comes with it, because the four hand-rolled
 * modals this replaced each owed some of it and none owed all of it: Escape closes,
 * the backdrop closes, the page behind does not scroll, and the click that closes
 * cannot leak to whatever sits under the backdrop.
 */
export function Overlay({
  onClose,
  children,
  label,
  className = "",
}: {
  onClose: () => void;
  children: React.ReactNode;
  /** Names the dialog for assistive tech — a bare `role="dialog"` announces nothing. */
  label: string;
  /** Layout for the panel itself. The backdrop is not configurable. */
  className?: string;
}) {
  // `createPortal` needs a DOM node, and there is none during SSR or the first
  // hydration pass. "Are we on the client" is external state, not derived state, so
  // it is subscribed to rather than mirrored in from an effect — same idiom the
  // header uses for scroll. The subscription never fires: the answer changes once,
  // at hydration, and React re-reads the snapshot then.
  const mounted = useSyncExternalStore(NEVER_CHANGES, () => true, () => false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Restored to whatever it was, not to "": a nested overlay or a future scroll
    // lock elsewhere would otherwise be cleared by whichever closes last.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 flex items-center justify-center bg-[var(--overlay)] p-lg backdrop-blur-sm"
      style={{ zIndex: "var(--z-overlay)" }}
      onClick={onClose}
    >
      <div
        className={`flex max-h-[86vh] w-full flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-1)] shadow-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
