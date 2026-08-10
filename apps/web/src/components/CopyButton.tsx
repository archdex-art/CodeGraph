"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copy one short string, and say so.
 *
 * The confirmation is the whole point: a clipboard write is invisible, so a button
 * without feedback leaves the user to paste somewhere and check. Two of these already
 * existed inline (the swarm's diff copy, the context prompt copy) with the same
 * 1500ms timer written twice; this is the third, so it becomes a component — including
 * the `clearTimeout` on unmount neither of the originals does.
 */
export function CopyButton({
  value,
  label,
  copiedLabel = "copied",
  title,
  className = "",
}: {
  value: string;
  label: string;
  copiedLabel?: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      title={title ?? value}
      aria-label={title ?? label}
      onClick={(e) => {
        // These sit inside rows that are themselves links to the editor; copying is not
        // navigating.
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      className={`inline-flex cursor-pointer items-center gap-2xs rounded-xs border border-[var(--line)] px-2xs py-hair text-micro transition-colors duration-200 hover:border-line-strong hover:text-[var(--text-primary)] ${
        copied ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"
      } ${className}`}
    >
      {copied ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
      {copied ? copiedLabel : label}
    </button>
  );
}
