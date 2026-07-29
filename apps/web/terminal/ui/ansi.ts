/**
 * Zero-dependency ANSI styling. Respects NO_COLOR / non-TTY.
 * Isolated here so the rest of the terminal layer never hardcodes escape codes.
 */
const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function wrap(open: number, close: number) {
  return (s: string | number): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}

export const color = {
  reset: "\x1b[0m",
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  bgMagenta: wrap(45, 49),
  bgGreen: wrap(42, 49),
  bgRed: wrap(41, 49),
  bgBlue: wrap(44, 49),
};

// 24-bit accent (purple, matching the web brand) with graceful fallback.
export function accent(s: string): string {
  return enabled ? `\x1b[38;2;167;139;250m${s}\x1b[39m` : s;
}

export const isColor = enabled;

// Visible length (strip escape codes) — for padding/tables.
export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function padEnd(s: string, width: number): string {
  const len = visibleLen(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
