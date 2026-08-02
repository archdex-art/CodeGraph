# CodeGraph — The Proportional System

| | |
|---|---|
| **Status** | Implemented |
| **Date** | 2026-08-02 |
| **Lives in** | `apps/web/src/app/globals.css` (`:root` + `@theme inline`) |
| **Enforced by** | `apps/web/tests/design-system.test.ts` |
| **Binding on** | every `.tsx` under `apps/web/src` |

## What this is

One ratio — φ = 1.618 — governs type, space, measure and radius across the whole surface.
It does not change the identity described in `IDENTITY.md`: the ink field, the single
chartreuse signal colour, violet for structure, coral for risk, Instrument Serif on the
headlines and mono on the numerals are all unchanged. This is the geometry underneath them.

## The problem it solves

Measured before any of it was written:

| | Before | After |
|---|---|---|
| Distinct font sizes rendered on the landing page | 22 | 9 |
| Distinct font sizes in the source | 25 (17 arbitrary `px`, 7 at half-pixels) | 8 rungs |
| Numeric spacing steps in use | 20, off Tailwind's linear 4px ramp | 10 rungs |
| Page frames | 2 (1152 marketing/dashboard, 1440 repo) | 1 |
| Two-column splits | `1:1` | φ |
| Max distinct sizes on any single route | 22 | 9 |

Twenty-five sizes is not a hierarchy. It is noise that happens to be legible, and it did
not arrive in one commit — it accumulated one locally-defensible `text-[13.5px]` at a time.

## Why φ, and how it is actually applied

This surface is an instrument: a dense field of readings where the difference between two
levels must be legible at a glance and at small sizes. A 1.2 scale is too tight to separate
adjacent levels below 16px; a 2.0 scale skips every size a dense UI needs.

Pure φ for type is also too coarse — 16 → 26 → 42 → 68 offers nothing between body copy and
a section heading. So **the ladder steps by √φ (1.272) and every second step is exactly φ**.
Eight sizes replace twenty-five; adjacent levels differ by 27%, above the ~20% threshold at
which a size difference reads as intentional; and the head-to-body relationship a reader
actually feels stays golden.

Values are **rounded to whole pixels**. φ is irrational, and chasing its decimals gives you
25.888px, which the rasteriser rounds anyway — badly, and differently per browser. The ratio
survives rounding; half-pixel type does not survive a hinting engine.

### Type

| token | px | derivation | role |
|---|---|---|---|
| `text-micro` | 10 | 16 / φ | eyebrows, channel labels, badges, legend keys |
| `text-meta` | 13 | 16 / √φ | the dense-UI workhorse: labels, cells, nav, buttons |
| `text-body` | 16 | base | prose |
| `text-lede` | 21 | 13 × φ | standfirst, large readings |
| `text-h3` | 26 | 16 × φ | card and panel headings |
| `text-h2` | 26 → 33 | 16 × φ√φ | section headings |
| `text-h1` | 33 → 42 | 16 × φ² | page titles |
| `text-display` | 42 → 68 | 16 × φ³ | the hero, and only the hero |

`lede` is 21 rather than the 20 you get from 16 × √φ, because rounding compounds: 20 against
13 is 1.538, a 5% error and the widest in the ladder. 21/13 = 1.615 restores it. The cost is
21/16 = 1.31 against √φ's 1.272 — the cheaper error, because the pair a reader compares is
the standfirst against the label beside it, not against body copy three sections away.

The top three rungs are fluid, and **the fluid range never leaves the ladder**: each clamps
between its own step and the step below, so a narrow viewport reads a smaller rung of the
same series rather than a size invented by a viewport unit.

Leading is derived, not chosen. Body sits at exactly φ (16 → 26) — the classical golden
line-height. Display sizes tighten toward √φ and then to near-solid, because leading that
tracks size linearly looks slack at display sizes and cramped at caption sizes.

### Space

The same progression, and — not by coincidence — the same numbers:

`hair` 2 · `2xs` 4 · `xs` 6 · `sm` 10 · `md` 16 · `lg` 26 · `xl` 42 · `2xl` 68 · `3xl` 110 · `4xl` 178

A 26px gap beside 26px type is one step of one system, not two systems that happen to agree.

### Measure

1864 is the top term of the series `272 → 440 → 712 → 1152 → 1864`, each φ times the last,
so the frame, the prose column and the rail are terms of one progression rather than three
decisions:

| token | px | derivation | role |
|---|---|---|---|
| `max-w-frame` | 1864 | top term | the page, on every route |
| `max-w-wide` | 1152 | frame / φ | a centred wide block |
| `max-w-measure` | 712 | frame / φ² | longest comfortable line at **body** (16px) |
| `max-w-note` | 440 | frame / φ³ | a helper paragraph at **meta** (13px) or **micro** |
| `max-w-rail` | 272 | frame / φ⁴ | the section navigation rail |
| `--rail-collapsed` | 68 | space rung | the rail with labels dropped |

**A measure belongs to a size, not to a block.** 712 is ~89 characters at 16px — correct — but
110 at 13px and 142 at 10px, both well past the readable ceiling. So prose takes the series
term matched to its rung: body → `measure`, meta and micro → `note`. Enforced by eye and by
measurement: no line on any route at any width now exceeds 95 characters.

The frame started at 1152 and that was too timid — on a 1568-wide display it left ~200px of
dead margin down each side while the report's content column was squeezed between them. A
frame narrower than the screen is a choice you make for READING, and reading is already
protected by `--measure`. `.shell` now fills the viewport to the 1864 cap, and the gutter
climbs the ladder with it (26 → 42 → 68) so the page margin stays part of the same series.

### Radius

`rounded-xs` 4 · `sm` 6 · `md` 10 · `lg` 16 · `xl` 26 — quantised onto the same ladder,
because a 26px pad inside a 10px corner is a relationship the eye checks.

## Layout primitives

- **`.shell`** — the one page frame: it fills the viewport up to 1864 and carries a gutter
  that is itself a ladder step, climbing 26 → 42 → 68 across the breakpoints. Every route
  uses it, which is why the content's left edge no longer moves when you navigate from the
  dashboard into a report.
- **`.split-phi`** — two columns in φ, major term first. The hero: copy 1.618, graph 1.
- **`.split-phi-rev`** — major term second. Code intelligence: search list 1, detail pane
  1.618, because the pane carrying the docstring, signature and relation list is the
  primary term and an even split starved it.

Both use `fr` units, so the proportion holds at every width without arithmetic — which a
hard-coded 712/440 pair does not — and both collapse to one column below 1024px, because a
golden section of 380px is two cramped columns.

## The collapsible rail

The report's section rail collapses to icons (272 → 68) so a graph, an editor or a diff can
have the width back — measured: the main column goes from 1134 to 1338 at a 1568 viewport.

Three decisions worth keeping:

- **Labels are removed from the DOM, not hidden.** A 68px rail cannot hold them, and
  `overflow:hidden` over text that is still laid out is what produces the half-clipped word
  every collapsed sidebar eventually shows. The label survives as `aria-label` and as the
  native tooltip, so the control keeps its accessible name.
- **The active section stays chartreuse in both states.** Collapsed, colour is the only
  affordance left saying where you are, so it carries more weight, not less. The per-section
  count degrades from a badge to a dot rather than disappearing.
- **The state is an external store, not component state.** It lives in `localStorage`,
  outlives the component and is shared across tabs, so it is read with
  `useSyncExternalStore`: `getServerSnapshot` returns the expanded default so the server and
  the first client paint agree, and a second tab's toggle is picked up through the `storage`
  event. Reading it in an effect instead is a cascading render on every mount — which
  `react-hooks/set-state-in-effect` flags as a hard error in this file.

## The one collision to know about

The spacing scale claims the names `sm`/`md`/`lg`/`xl`, and in Tailwind v4 the spacing
namespace wins those names for `max-w-*` as well. `max-w-md` therefore resolves to **16px**,
not 448. This was found the hard way: the footer paragraph collapsed to a 16px column and
pushed every page 8px wide at the 768 breakpoint.

**Every width names a term of the φ series instead** (`max-w-frame`/`measure`/`note`/`rail`),
and `design-system.test.ts` fails the build if a t-shirt measure comes back.

## What is deliberately exempt

Text inside an SVG coordinate system — graph node labels, axis keys, anything that scales
with zoom — is data geometry, not layout rhythm. Those are the only text nodes in the app
that render at a size off the ladder, and they render off it *because they are being scaled*
by the view transform.

## Enforcement

`apps/web/tests/design-system.test.ts` asserts, per file:

- no arbitrary `text-[…px]` and no Tailwind t-shirt font size;
- no numeric spacing utility off the ladder (`p-2`, `gap-1.5`, `-mx-6`);
- no shadowed t-shirt measure;

and, on the tokens themselves, that every rung exists and that the series is still golden —
`body/micro`, `h3/body`, `lede/meta` and `lead-body/body` all ≈ φ, `frame/measure` ≈ φ,
`measure/rail` ≈ φ². That last group caught a genuine 5% error in the first draft of the
ladder, which is the reason the tests assert the ratio and not just the presence of a token.
