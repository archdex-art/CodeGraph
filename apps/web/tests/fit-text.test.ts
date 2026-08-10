import { afterEach, describe, expect, it } from "vitest";
import { clearTextMeasurements, fitText, fontSpec } from "@/lib/fitText";
import { plural } from "@/lib/plural";

/**
 * Label truncation, by measured width.
 *
 * THE BUG THIS EXISTS TO STOP COMING BACK. The graph truncated labels by counting characters —
 * `label.length > 20 ? label.slice(0, 19) + "…" : label` — inside 148px file cards. Measured in
 * a real browser at the font the graph actually draws with (13px/600 Geist), on the four labels
 * from the report that surfaced it:
 *
 *   M6_ENTRY_CRITERIA.md         20 chars → never truncated → overflowed by 22.5px
 *   LOCAL_RUNTIME_BENCHMARKS.md  truncated to 20 → still overflowed by 34.5px
 *   M5_COMPLETION_REPORT.md      truncated to 20 → still overflowed by 39px
 *   RESEARCH_LOG.md              15 chars → fit, with 7.8px to spare
 *
 * Three of four wrong, in both directions, which is what a character count buys: at one length
 * `MMMMMMMMMMMMMMMMMMMM` and `iiiiiiiiiiiiiiiiiiii` differ by more than 3x. Raising the constant
 * only moves which labels break.
 *
 * `measureText` is not implemented in jsdom, so these drive a STUB context whose metrics are
 * declared per test. That is the right seam: what is under test is the fitting logic — does it
 * respect the budget, does it binary-search correctly, does it handle the degenerate widths —
 * and none of that should depend on which font the CI box has installed.
 */

/**
 * A canvas stub whose glyph widths are whatever the test says they are.
 *
 * The suite runs in the `node` environment (`apps/web/vitest.config.ts`), so there is no
 * `document` and no jsdom `measureText` — jsdom does not implement it anyway, and pulling the
 * dependency in to get a stub that still needs overriding would buy nothing. Defining the
 * global directly exercises the REAL code path, including the `typeof document === "undefined"`
 * guard the module needs for SSR.
 */
function stubCanvas(widthOf: (text: string, font: string) => number): void {
  const ctx = {
    font: "",
    measureText(text: string) {
      return { width: widthOf(text, ctx.font) };
    },
  };
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
      return { getContext: () => ctx };
    },
  };
  clearTextMeasurements();
}

/** 10px per character — enough to make every expectation below arithmetic. */
const TEN_PER_CHAR = (text: string): number => text.length * 10;

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  clearTextMeasurements();
});

const FONT = fontSpec(600, 13, "Test Sans");

describe("fitText", () => {
  it("returns a label that already fits, untouched", () => {
    stubCanvas(TEN_PER_CHAR);
    expect(fitText("abcde", 100, FONT)).toBe("abcde");
  });

  it("truncates a label that does not fit", () => {
    stubCanvas(TEN_PER_CHAR);
    // 10 chars = 100px against a 65px budget. The result plus its ellipsis must fit: 5 glyphs
    // (4 kept + the ellipsis) = 50px, 6 would be 60px, 7 would be 70px — so 6 kept is the most.
    const out = fitText("abcdefghij", 65, FONT);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length * 10).toBeLessThanOrEqual(65);
  });

  it("never returns something wider than the budget, over many lengths", () => {
    // The property that actually matters, asserted as a property rather than on one example.
    stubCanvas(TEN_PER_CHAR);
    for (let n = 0; n < 40; n++) {
      for (const budget of [0, 5, 12, 37, 100, 401]) {
        const out = fitText("x".repeat(n), budget, FONT);
        expect(out.length * 10).toBeLessThanOrEqual(Math.max(0, budget));
      }
    }
  });

  it("keeps as much of the label as the budget allows", () => {
    // The opposite failure: a fitter that always returns "…" never overflows and is useless.
    stubCanvas(TEN_PER_CHAR);
    // 95px at 10px/char is nine glyphs: eight kept plus the ellipsis is 90px, and one more
    // would be 100px. Asserting the exact string is what catches an off-by-one in the search.
    const out = fitText("abcdefghij", 95, FONT);
    expect(out).toBe("abcdefgh…");
  });

  it("truncates a WIDE-glyph label harder than a narrow one of the same length", () => {
    // The whole point. Same character count, different widths — a character rule cannot tell
    // these apart, and this is the exact shape of the reported bug.
    stubCanvas((text) => [...text].reduce((sum, ch) => sum + (ch === "M" ? 20 : 5), 0));
    const wide = fitText("MMMMMMMMMMMMMMMMMMMM", 100, FONT);
    const narrow = fitText("iiiiiiiiiiiiiiiiiiii", 100, FONT);
    expect(wide.length).toBeLessThan(narrow.length);
  });

  it("truncates a 20-character label that overflows, which the old rule never did", () => {
    // `M6_ENTRY_CRITERIA.md` is exactly 20 characters, so `length > 20` was false and it was
    // rendered whole, 22.5px past the card edge.
    stubCanvas(TEN_PER_CHAR);
    const out = fitText("M6_ENTRY_CRITERIA.md", 124, FONT);
    expect(out).not.toBe("M6_ENTRY_CRITERIA.md");
    expect(out.length * 10).toBeLessThanOrEqual(124);
  });

  it("does not leave a separator stranded before the ellipsis", () => {
    stubCanvas(TEN_PER_CHAR);
    // Cutting mid-word after an underscore reads as a typo rather than as elision.
    expect(fitText("ABC_DEFGH", 55, FONT)).toBe("ABC…");
  });

  it("returns the ellipsis alone when only it fits", () => {
    stubCanvas(TEN_PER_CHAR);
    expect(fitText("abcdef", 10, FONT)).toBe("…");
  });

  it("returns nothing when not even the ellipsis fits", () => {
    // Better an empty label than one glyph hanging outside the card.
    stubCanvas(TEN_PER_CHAR);
    expect(fitText("abcdef", 4, FONT)).toBe("");
  });

  it("returns nothing for a non-positive budget", () => {
    stubCanvas(TEN_PER_CHAR);
    expect(fitText("abcdef", 0, FONT)).toBe("");
    expect(fitText("abcdef", -20, FONT)).toBe("");
  });

  it("measures the same text differently under a different font", () => {
    // The cache is keyed on (font, text). Sharing one entry across fonts is how a label fitted
    // against the loading FALLBACK face stays wrong after the webfont swaps in.
    stubCanvas((text, font) => text.length * (font.includes("Wide") ? 20 : 5));
    const narrow = fitText("abcdefghij", 60, fontSpec(600, 13, "Test Sans"));
    const wide = fitText("abcdefghij", 60, fontSpec(600, 13, "Wide Sans"));
    expect(wide.length).toBeLessThan(narrow.length);
  });

  it("re-measures after the cache is cleared, so a font swap is picked up", () => {
    // `clearTextMeasurements` is called when `document.fonts.ready` resolves. If it did not
    // actually invalidate, every label fitted during load would keep its fallback-sized cut.
    let perChar = 5;
    stubCanvas((text) => text.length * perChar);
    expect(fitText("abcdefghij", 60, FONT)).toBe("abcdefghij");

    perChar = 20;
    clearTextMeasurements();
    const after = fitText("abcdefghij", 60, FONT);
    expect(after).not.toBe("abcdefghij");
    expect(after.length * 20).toBeLessThanOrEqual(60);
  });
});

describe("plural", () => {
  /**
   * Every graph card rendered `${count} files`, so a single-file module read
   * "1 files · 380 LOC" on the architecture view, the network view, and every card between.
   */
  it("uses the singular for exactly one", () => {
    expect(plural(1, "file")).toBe("1 file");
  });

  it("uses the plural for none and for many", () => {
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "file")).toBe("2 files");
  });

  it("groups large counts, matching every other number on a card", () => {
    expect(plural(1234, "file")).toBe("1,234 files");
  });

  it("takes an irregular plural rather than forcing an -s", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});
