/**
 * Truncate a label to a PIXEL width, by measuring it.
 *
 * WHAT THIS REPLACES, AND WHY IT KEPT COMING BACK. The graph truncated labels by counting
 * characters — `label.length > 20 ? label.slice(0, 19) + "…" : label` — against boxes 180px
 * wide. A character count cannot know a pixel width, so the rule was a guess calibrated on
 * whatever text happened to be on screen when it was written, and it failed in both directions:
 *
 *   · `M6_ENTRY_CRITERIA.md` is exactly 20 characters, so it was never truncated at all, and
 *     at 13px/600 it is wider than the card. It rendered straight through the border.
 *   · `LOCAL_RUNTIME_BENCH…` WAS truncated to 20 and still overflowed, because uppercase
 *     letters and underscores are far wider than the ~7px/char the threshold assumes.
 *
 * Lowercase prose fits at 20 characters, which is why the bug looks intermittent and why
 * raising the constant only moves it: `iiiiiiiiiiiiiiiiiiii` and `MMMMMMMMMMMMMMMMMMMM` differ
 * by more than a factor of three at the same length. The only rule that holds for both is the
 * measured one.
 *
 * Canvas rather than SVG's `getComputedTextLength`: that needs the element in the document and
 * forces a layout pass per node, and the graph re-renders every frame while panning. A 2D
 * context measures the same glyphs with no DOM at all.
 */

/**
 * One offscreen context for the process. Created lazily so importing this module is safe during
 * SSR, where there is no `document`.
 */
let ctx: CanvasRenderingContext2D | null = null;
function measuringContext(): CanvasRenderingContext2D | null {
  if (ctx) return ctx;
  if (typeof document === "undefined") return null;
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

/**
 * Measurements are pure in `(font, text)` and the graph asks for the same labels on every
 * frame, so they are cached. Bounded because a repository can hold thousands of distinct
 * labels and this map would otherwise be a leak that grows with panning.
 */
const CACHE_LIMIT = 4_000;
const widths = new Map<string, number>();

function widthOf(text: string, font: string): number {
  const key = `${font}\u0000${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;

  const c = measuringContext();
  // No canvas (SSR, or a context the browser refused): fall back to an estimate rather than
  // throwing. The estimate is deliberately WIDE — over-truncating is a cosmetic loss, and
  // under-truncating is the bug this file exists to fix.
  const measured = c === null ? text.length * 8.5 : ((c.font = font), c.measureText(text).width);

  if (widths.size >= CACHE_LIMIT) widths.clear();
  widths.set(key, measured);
  return measured;
}

/** A CSS `font` shorthand for the canvas, matching what SVG text will actually render with. */
export function fontSpec(weight: number, sizePx: number, family: string): string {
  return `${weight} ${sizePx}px ${family}`;
}

/**
 * `text`, or the longest prefix of it that fits `maxWidth` once an ellipsis is appended.
 *
 * Binary search over the prefix length: a linear scan is O(n) measurements per label per
 * frame, and the graph draws hundreds of labels.
 */
export function fitText(text: string, maxWidth: number, font: string): string {
  if (maxWidth <= 0) return "";
  if (widthOf(text, font) <= maxWidth) return text;

  const ellipsis = "…";
  // Not even one character plus the ellipsis fits. Returning the bare ellipsis is honest —
  // something was elided — and it is the only string guaranteed not to overflow.
  if (widthOf(ellipsis, font) > maxWidth) return "";

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (widthOf(text.slice(0, mid) + ellipsis, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  // Trailing spaces and separators before an ellipsis read as a typo rather than as elision.
  return text.slice(0, lo).replace(/[\s.,;:_/-]+$/, "") + ellipsis;
}

/**
 * Drop every cached measurement, and the context they were taken with.
 *
 * Called when the webfont finishes loading. Next's font loading is asynchronous, so the first
 * frames measure against the FALLBACK face — and the fallback is narrower than Geist, so labels
 * cached then are truncated too late and overflow once the real font swaps in. This is the
 * subtlety that made the character-count bug look fixed in development and reappear on a cold
 * load, and the fix is not complete without an invalidation.
 *
 * The CONTEXT is dropped too, not just the widths. A memo that can never be re-resolved is a
 * memo that outlives the thing it measured — the browser may hand back a context whose backing
 * font set has changed, and a test cannot substitute a measurer at all. Re-creating one canvas
 * costs nothing next to the frame it is about to be used in.
 */
export function clearTextMeasurements(): void {
  widths.clear();
  ctx = null;
}
