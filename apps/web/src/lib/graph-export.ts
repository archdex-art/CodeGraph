/**
 * Taking a graph out of the app.
 *
 * `svg.outerHTML` is the obvious implementation and it produces a black rectangle in
 * every viewer that is not this tab. Almost every colour on these canvases is a
 * `var(--…)` — `stroke: var(--accent-text)`, `fill: var(--surface-2)` — and those
 * custom properties are declared on `:root` by the app's stylesheet, which does not
 * travel with the markup. An undefined `var()` on a paint property falls back to the
 * initial value: black fill, no stroke. So the export re-declares, on the exported
 * root, the computed value of every custom property the markup mentions. Custom
 * properties inherit, so one `style` attribute on the `<svg>` resolves the whole
 * tree, and the file is self-contained.
 *
 * The background comes with it for the same reason: the canvas gets its surface from
 * the wrapper `<div>`, not from the `<svg>`, so an exported diagram of pale text
 * lands on the viewer's white page and disappears.
 */

/** Any `--custom-property` token, wherever it appears in the serialised markup. */
const CUSTOM_PROPERTY = /--[a-zA-Z][\w-]*/g;

/**
 * The live canvas as a standalone SVG document.
 *
 * `background` is the token to paint behind everything — the same one the wrapper
 * uses, so the file looks like what was on screen rather than like what was on top
 * of it.
 */
export function serialiseGraphSvg(svg: SVGSVGElement, background = "--surface-1"): string {
  // The size React drew it at, with the laid-out box as the fallback.
  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(Number(svg.getAttribute("width")) || rect.width));
  const h = Math.max(1, Math.round(Number(svg.getAttribute("height")) || rect.height));
  const clone = svg.cloneNode(true) as SVGSVGElement;

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
  // A grab cursor is a property of the interactive canvas, not of a file.
  clone.style.removeProperty("cursor");

  /* The search halo is drawn by a keyframe animation that ends at `opacity: 0`. The
     stylesheet does not travel, so left in it exports as a solid accent ring around
     whatever happened to be focused — a mark the viewer cannot explain. */
  for (const halo of Array.from(clone.querySelectorAll(".ng-focus-halo"))) halo.remove();

  const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  backdrop.setAttribute("width", String(w));
  backdrop.setAttribute("height", String(h));
  backdrop.setAttribute("fill", `var(${background})`);
  clone.insertBefore(backdrop, clone.firstChild);

  const serialiser = new XMLSerializer();
  const used = new Set(serialiser.serializeToString(clone).match(CUSTOM_PROPERTY) ?? []);
  /* Read from the LIVE element, not from `documentElement`: the theme is a class on an
     ancestor, so the same token is a different colour depending on where you ask. A
     custom property's computed value already has its own `var()` references
     substituted, so one lookup per token is enough — no transitive resolution here. */
  const computed = getComputedStyle(svg);
  for (const token of used) {
    const value = computed.getPropertyValue(token).trim();
    if (value) clone.style.setProperty(token, value);
  }
  // Not embedded — declaring the family at least lets a viewer pick the same stack
  // rather than falling back to its default serif.
  clone.style.setProperty("font-family", computed.fontFamily);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialiser.serializeToString(clone)}`;
}

/**
 * That SVG drawn to a canvas, at `scale`× so the PNG survives being pasted into a
 * document at full width.
 *
 * The markup goes through a blob URL rather than a `data:` URI: a hundred-node
 * diagram serialises past the length some browsers accept in an `img.src`, and a
 * same-origin blob of SVG that references nothing external does not taint the
 * canvas, so `toBlob` still works.
 */
export async function rasteriseSvg(markup: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The diagram could not be rasterised."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The diagram could not be rasterised.");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The diagram could not be rasterised."))),
        "image/png"
      )
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked on a later turn: Safari reads the URL asynchronously after the click, so
  // revoking in the same tick cancels the download it was meant to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
