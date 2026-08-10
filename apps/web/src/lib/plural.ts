/**
 * `3 files`, and `1 file`.
 *
 * Every graph card rendered `${count} files`, so a single-file module read "1 files · 380 LOC"
 * on the architecture view, the network view and every card in between. It is small and it is
 * the kind of small that reads as nobody having looked at the screen.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `fitText`
 *
 * It started next to `fitText` on the reasoning that both produce the label text a node card
 * shows. That held only while the callers were all views. The moment the agent orchestrator
 * needed it — server-side, to stop suffixing bare counts with a parenthesised s — importing
 * it dragged `fitText` along, and `fitText` measures text with a canvas: it names `document`
 * and `CanvasRenderingContext2D`. Those types do not exist in a Node compilation, so a
 * pluralisation helper broke `tsc -p scripts/tsconfig.json`.
 *
 * A pure string function has no business carrying a DOM dependency to its callers. It lives
 * alone so both halves of the product can use it.
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  // Grouped, because these land in prose next to LOC counts that are grouped: "1,234 files".
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}
