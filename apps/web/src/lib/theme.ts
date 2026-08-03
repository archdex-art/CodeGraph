/**
 * The theme, as an external store.
 *
 * It lives in `localStorage`, outlives every component, and is shared with the
 * other tabs — so it is read with `useSyncExternalStore` rather than synced into
 * component state by an effect, for the same reasons the report rail is.
 *
 * Three states, not two. "System" is a real answer and the default one: a user
 * who has set their OS to switch at sunset has already expressed the preference,
 * and a two-state toggle silently overrides it on first visit. Once they touch
 * the control they have expressed a preference of their own, and from then on it
 * outranks the OS — including on a machine that disagrees.
 */
export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "cg:theme";

const listeners = new Set<() => void>();

function isChoice(value: string | null): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

export function subscribeTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  // The OS can change under us while "system" is selected.
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
    media.removeEventListener("change", onChange);
  };
}

/** Must be stable for an unchanged store: both return values are primitives. */
export function readThemeChoice(): ThemeChoice {
  const stored = window.localStorage.getItem(THEME_KEY);
  return isChoice(stored) ? stored : "system";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function writeThemeChoice(choice: ThemeChoice): void {
  window.localStorage.setItem(THEME_KEY, choice);
  // The attribute is the single source of truth for CSS, and it always holds a
  // RESOLVED value — "system" never reaches the DOM, so the stylesheet needs one
  // selector rather than a selector plus a media query fighting over specificity.
  document.documentElement.setAttribute("data-theme", resolveTheme(choice));
  for (const notify of listeners) notify();
}

/**
 * Runs in `<head>`, before first paint, as a blocking inline script.
 *
 * Without it the server sends ink markup and a light-mode user gets a full white
 * flash on every navigation — the one theming bug everybody ships. It is stringified
 * rather than imported because it has to execute before the bundle exists, and it
 * is wrapped in try/catch because Safari throws on `localStorage` in private mode
 * and a theme preference is not worth a blank page.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_KEY)});
    var choice = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    var resolved = choice === "system"
      ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : choice;
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
`.trim();
