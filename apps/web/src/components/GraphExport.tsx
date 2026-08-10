"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Download, Link2, Share2 } from "lucide-react";
import { downloadBlob, rasteriseSvg, serialiseGraphSvg } from "@/lib/graph-export";

/**
 * Getting a diagram out of the tab it was drawn in.
 *
 * Three ways out, because they answer different questions. A link answers "look at
 * this" — it carries the state you arrived at, so the person you send it to opens
 * the same module you opened. An SVG answers "put this in the design doc" and stays
 * sharp when someone scales it. A PNG answers "paste this into Slack", where SVG is
 * not accepted.
 *
 * Shaped as the same floating pill as `Expand all`, deliberately: these are the two
 * controls that sit over a canvas rather than beside it, and a second shape for the
 * second one would read as a second kind of thing.
 */
export function GraphExport({
  canvasRef,
  repoName,
  view,
}: {
  /** Wrapper holding the drawing. The `<svg>` is found inside it by data attribute —
   *  a bare `querySelector("svg")` finds the search box's magnifier icon instead. */
  canvasRef: RefObject<HTMLElement | null>;
  repoName: string;
  /** Which drawing this is, second half of the file name. */
  view: "network" | "architecture" | "circle-pack";
}) {
  const [open, setOpen] = useState(false);
  /** The outcome of the last action, shown in place of the label. */
  const [note, setNote] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // `mousedown`, not `click`: a click on the canvas underneath deselects a node, and
    // the menu should be gone before that lands rather than swallowing the gesture.
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2400);
    return () => clearTimeout(t);
  }, [note]);

  const base = `${repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph"}-${view}`;

  async function run(kind: "link" | "svg" | "png") {
    setOpen(false);
    try {
      if (kind === "link") {
        // The state is already in the URL — that is the whole point of the deep link,
        // so there is nothing to build here.
        await navigator.clipboard.writeText(window.location.href);
        setNote("Link copied");
        return;
      }
      const svg = canvasRef.current?.querySelector<SVGSVGElement>("svg[data-graph-canvas]");
      if (!svg) throw new Error("no canvas");
      const markup = serialiseGraphSvg(svg);
      if (kind === "svg") {
        downloadBlob(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }), `${base}.svg`);
        setNote("SVG saved");
      } else {
        downloadBlob(await rasteriseSvg(markup), `${base}.png`);
        setNote("PNG saved");
      }
    } catch {
      // Nothing here is worth a stack trace in the user's face; the retry is one click.
      setNote("Export failed");
    }
  }

  const item =
    "flex w-full items-center gap-xs px-sm py-xs text-left text-meta text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--surface-active)]";

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-2xs self-start rounded-full border border-[var(--line)] bg-[var(--surface-1)]/85 px-sm py-xs text-micro text-[var(--text-secondary)] shadow-lg backdrop-blur transition-[transform,color,border-color,background-color] duration-200 ease-out hover:-translate-y-px hover:border-[var(--accent-text)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:translate-y-0"
        title="Copy a link to this view, or save it as a file"
        aria-expanded={open}
      >
        <Share2 className="h-3.5 w-3.5 transition-transform duration-300 ease-out group-hover:scale-110" aria-hidden />
        {note ?? "Share"}
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2xs w-48 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface-2)] shadow-2xl">
          <button onClick={() => run("link")} className={item}>
            <Link2 className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
            Copy link
          </button>
          <button onClick={() => run("svg")} className={item}>
            <Download className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
            Download SVG
          </button>
          <button onClick={() => run("png")} className={item}>
            <Download className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
            Download PNG
          </button>
        </div>
      )}
    </div>
  );
}
