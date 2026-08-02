import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The proportional system, enforced structurally.
 *
 * This exists because the system it guards was RECOVERED, not designed once: the
 * landing page alone rendered 22 distinct font sizes (12.5, 13.5, 14.5, 15.5, 16.5,
 * 20.8, 23.2, 43.68, 49.6…), the codebase carried 25 across 40 components, and the
 * spacing came off 20 ad-hoc rungs of Tailwind's linear ramp. None of that arrived in
 * one commit. It accumulated one reasonable-looking `text-[13.5px]` at a time, and
 * every one of them was locally defensible.
 *
 * A design system that is only a convention decays back to that state. These tests
 * make the ladder a property of the repository: a size that is not a rung fails here,
 * with the same weight as a type error.
 *
 * See the "THE PROPORTIONAL SYSTEM" block in `src/app/globals.css` for the derivation.
 */
const SRC = path.resolve(__dirname, "../src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const FILES = sources(SRC).map((f) => [path.relative(SRC, f), readFileSync(f, "utf8")] as const);

/** `p-2`, `-mx-6`, `gap-1.5` … — the linear ramp the φ ladder replaced. */
const NUMERIC_SPACING =
  /(?<![\w-])-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-y|space-x)-(\d+(?:\.\d)?)(?![\w./[])/g;

/** Tailwind's container names, which the spacing scale shadows — see globals.css. */
const SHADOWED_MEASURE = /max-w-(?:2xs|xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)\b/g;

describe("the type ladder", () => {
  it("scans the components it claims to, so the suite cannot pass by finding nothing", () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it.each(FILES.map(([name, src]) => [name, src]))(
    "%s states no font size off the ladder",
    (_name, src) => {
      // An arbitrary size is how all 25 of them got here. The ladder is
      // text-micro/meta/body/lede/h3/h2/h1/display; anything else is a new rung
      // invented at a call site, which is exactly what this forbids.
      expect(src.match(/text-\[[\d.]+(?:px|rem|em)\]/g) ?? []).toEqual([]);
    }
  );

  it.each(FILES.map(([name, src]) => [name, src]))(
    "%s uses no Tailwind t-shirt font size",
    (_name, src) => {
      expect(src.match(/\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/g) ?? []).toEqual([]);
    }
  );
});

describe("the space ladder", () => {
  it.each(FILES.map(([name, src]) => [name, src]))(
    "%s spaces on the ladder, not on the 4px ramp",
    (_name, src) => {
      // `p-0` survives: zero is not a step, it is the absence of one.
      const offLadder = [...src.matchAll(NUMERIC_SPACING)]
        .map((m) => m[0])
        .filter((m) => !/-0$/.test(m));
      expect(offLadder).toEqual([]);
    }
  );
});

describe("measures", () => {
  it.each(FILES.map(([name, src]) => [name, src]))(
    "%s names its measures instead of using shadowed t-shirt widths",
    (_name, src) => {
      // Not a style rule: `--spacing-md` wins the name `md` for `max-w-*` too, so
      // `max-w-md` silently resolves to 16px. That collapsed the footer paragraph to a
      // 16px column and pushed every page 8px wide at the 768 breakpoint.
      expect(src.match(SHADOWED_MEASURE) ?? []).toEqual([]);
    }
  );
});

describe("the tokens themselves", () => {
  const css = readFileSync(path.join(SRC, "app/globals.css"), "utf8");

  it("defines every rung of both ladders", () => {
    for (const t of ["micro", "meta", "body", "lede", "h3", "h2", "h1", "display"]) {
      expect(css).toContain(`--size-${t}:`);
      expect(css).toContain(`--lead-${t}:`);
    }
    for (const s of ["hair", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]) {
      expect(css).toContain(`--space-${s}:`);
    }
  });

  it("keeps the ladder in golden proportion", () => {
    const px = (name: string) => {
      const m = css.match(new RegExp(`--size-${name}:\\s*(\\d+)px`));
      return m ? Number(m[1]) : Number.NaN;
    };
    // Every SECOND step is φ apart — that is the property that makes the head/body
    // relationship golden while still leaving a usable rung between the two.
    expect(px("body") / px("micro")).toBeCloseTo(1.618, 1);
    expect(px("h3") / px("body")).toBeCloseTo(1.618, 1);
    expect(px("lede") / px("meta")).toBeCloseTo(1.618, 1);
    // Body leading is exactly φ: 16 → 26.
    const lead = Number(css.match(/--lead-body:\s*(\d+)px/)?.[1]);
    expect(lead / px("body")).toBeCloseTo(1.618, 1);
  });

  it("derives the measures from the frame by repeated division", () => {
    const frame = Number(css.match(/--frame:\s*(\d+)px/)?.[1]);
    const measure = Number(css.match(/--measure:\s*(\d+)px/)?.[1]);
    const rail = Number(css.match(/--rail:\s*(\d+)px/)?.[1]);
    expect(frame / measure).toBeCloseTo(2.618, 1); // φ²
    expect(measure / rail).toBeCloseTo(2.618, 1); // φ², i.e. two more divisions
  });
});
