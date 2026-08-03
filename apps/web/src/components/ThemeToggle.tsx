"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  readThemeChoice,
  subscribeTheme,
  writeThemeChoice,
  type ThemeChoice,
} from "@/lib/theme";

/**
 * Three states in a row, not a two-state switch.
 *
 * A switch has to answer "is this showing the current theme or the one I'd get
 * if I pressed it", and it cannot represent "follow my system" at all — so the
 * first visit of a light-mode user silently overrides a preference they already
 * set. Three explicit segments say what is selected and what the alternatives
 * are, in the same amount of chrome.
 */
const OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  // `getServerSnapshot` returns "system" so the server and the first client paint
  // agree; the pre-paint script has already applied the real theme to <html>, so
  // the page is never the wrong colour even for the frame before this hydrates.
  const choice = useSyncExternalStore(subscribeTheme, readThemeChoice, () => "system" as ThemeChoice);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={`inline-flex items-center gap-hair rounded-md border border-[var(--line)] bg-[var(--surface-2)] p-hair ${className}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={`${label} theme`}
            onClick={() => writeThemeChoice(value)}
            className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm transition-colors duration-200 ${
              selected
                ? "bg-[var(--surface-active)] text-[var(--accent-text)]"
                : "text-[var(--text-faint)] hover:text-[var(--text-secondary)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
