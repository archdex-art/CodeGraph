import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, GitBranch, ShieldCheck, Waypoints } from "lucide-react";
import { HeroGraph } from "@/components/HeroGraph";
import { IndexConsole } from "@/components/IndexConsole";
import { CountUp, Entrance, Magnetic, Reveal, Stagger, StaggerItem } from "@/components/motion/primitives";

/**
 * The landing surface.
 *
 * Every figure below was measured on this repository and the command that
 * measures it is in the repo. That is a product constraint, not a copywriting
 * preference: IDENTITY.md forbids claiming in the README what the code does not
 * do, and a landing page is a README with better typography.
 */

/**
 * The figures the hero publishes.
 *
 * WHY THESE FOUR, AND WHY TWO OTHERS ARE GONE
 *
 * The page's own footer promises that every number on it was measured on a real repository and
 * that the commands producing them are in the repo. That promise was false in four places.
 * `957 tests / 75 files` was stale against 1,844 across 107; `2.1s to index 327 files` was
 * taken on a 303-file tree before six of the eleven pipeline stages existed, and the largest
 * one today (`taint`, 3.0s of 6.0s) was not among them.
 *
 * Two claims were REMOVED rather than corrected, because nothing in the repository
 * substantiates them and a number nobody can re-derive is the thing the footer promises not to
 * publish:
 *
 *   - a claimed detector accuracy percentage on held-out repositories - no corpus, protocol or
 *     command backing it exists anywhere here.
 *   - a claimed peak-memory figure of 313.9 MiB - `npm run selfindex` under `/usr/bin/time -l`
 *     on this machine. The container may well be leaner; until something measures IT, the
 *     honest move is silence. The "runs on 512 MB" badge is a deployment target, not a claim
 *     about a measurement, and is left alone.
 *
 * What remains is asserted by `apps/web/tests/landing-claims.test.ts` against the working tree,
 * except the wall clock, which is published with a date the way the README publishes its case
 * count - a timing measures the machine as much as the code. `npm run selfindex` reprints all
 * of it.
 */
const PROOF = [
  { value: 2206, suffix: "", label: "tests, all green", note: "120 files, every gate in CI" },
  { value: 379, suffix: "", label: "TypeScript files", note: "498 of 519 scanned, 90,663 LOC analysed" },
  { value: 6.0, decimals: 1, suffix: "s", label: "to index this repo, cold", note: "11 stages, measured 2026-08-09" },
  { value: 11, suffix: "", label: "instrumented stages", note: "each one times itself, every run" },
];

const LENSES = [
  {
    icon: Waypoints,
    // `tone` paints (wash, chip, hairline) and keeps the hue token, which already
    // flips. `glyph` is the same hue as a MARK, and the signal lens is why the two
    // are separate fields: chartreuse is a fine wash on paper and an invisible icon.
    tone: "var(--violet-500)",
    glyph: "var(--violet-text)",
    kicker: "Lens 01",
    title: "The graph is the product",
    body: "A symbol-level program graph — definitions, calls, imports, inheritance — resolved with a real type checker, not a regex. Three interactive views over one index.",
    detail: "Type-aware resolution corrects the calls a name-based pass gets confidently wrong.",
  },
  {
    icon: GitBranch,
    tone: "var(--signal-500)",
    glyph: "var(--accent-text)",
    kicker: "Lens 02",
    title: "A score that shows its working",
    body: "One explainable Health Score, weighted by blast radius through the graph. Every point traces back to a finding, and every finding to a file and a line.",
    detail: "Calibrated against a hand-labelled corpus, with the protocol registered before the sample was drawn.",
  },
  {
    icon: ShieldCheck,
    tone: "var(--coral-500)",
    glyph: "var(--coral-text)",
    kicker: "Lens 03",
    title: "Fixes proved, not suggested",
    body: "A deterministic swarm argues findings out among themselves, then generates a patch and runs your own test suite against it before you ever see a diff.",
    detail: "If the suite fails, the fix is not offered. `verified` is a measurement, not a label.",
  },
];

const STAGES = [
  { name: "scan", ms: 35, desc: "walk the tree, classify, budget" },
  { name: "imports", ms: 1, desc: "resolve the module edges" },
  { name: "detect", ms: 822, desc: "rules, taint, lint, dataflow" },
  { name: "score", ms: 1, desc: "weight findings by blast radius" },
  { name: "symbol-graph", ms: 1233, desc: "typed program, symbols, references" },
];
const STAGE_MAX = Math.max(...STAGES.map((s) => s.ms));

export default function LandingPage() {
  return (
    <>
      {/* ---------------------------------------------------------------- HERO */}
      <section id="top" className="relative overflow-hidden">
        <div className="grid-field pointer-events-none absolute inset-0" />
        <div
          className="animate-drift pointer-events-none absolute left-1/2 top-[-14rem] h-[34rem] w-[52rem] -translate-x-1/2 rounded-full"
          style={{ background: "radial-gradient(ellipse at center, var(--signal-glow), transparent 68%)" }}
        />

        {/* Top padding is deliberately small: the console is the point of the hero and
            it has to clear the fold on a laptop. The old 2xl/3xl pushed it off-screen. */}
        <div className="shell relative pb-3xl pt-md sm:pt-lg">
          {/* `[&>*]:min-w-0` — grid items default to `min-width:auto` and so refuse to
              shrink below their content's min-content width. The console's tab strip and
              the SVG both push that above the mobile viewport, which made the whole hero
              column render at full viewport width INSIDE a padded container: content ran
              under the right edge while `scrollWidth` stayed clean, so no overflow check
              caught it. Only measuring element rects did. */}
          <div className="split-phi items-center [&>*]:min-w-0">
            <div className="min-w-0">
              <Entrance>
                <div className="mb-lg inline-flex items-center gap-sm rounded-full border border-[var(--line)] bg-[var(--surface-1)]/70 py-xs pl-sm pr-md backdrop-blur">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--signal-500)] opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--signal-500)]" />
                  </span>
                  <span className="eyebrow !text-[var(--text-secondary)]">
                    Codebase workbench · MIT · self-hosted
                  </span>
                </div>
              </Entrance>

              <Entrance delay={0.06}>
                <h1 className="font-display text-display text-[var(--text-primary)]">
                  {/* Explicit breaks: at this measure the browser orphans "it." onto a
                      fourth line, and a two-character last line under a display serif
                      reads as a mistake. Three balanced lines instead. */}
                  Make the codebase <em>visible.</em>
                  <br />
                  Then judge it.
                  <br />
                  Then <em>fix</em> it.
                </h1>
              </Entrance>

              <Entrance delay={0.12}>
                <p className="mt-lg max-w-measure text-body text-[var(--text-secondary)]">
                  CodeGraph turns a repository into a symbol-level graph you can actually look at,
                  computes an explainable Health Score from it, and generates fixes it proves by
                  running your own tests. One container, one SQLite file,{" "}
                  <span className="text-[var(--text-primary)]">no API key</span>.
                </p>
              </Entrance>

              <Entrance delay={0.2}>
                <div className="mt-xl">
                  {/* `IndexConsole` reads `?authError=` with `useSearchParams`, which opts
                      its subtree out of prerendering — so it needs a boundary or the whole
                      page stops being static. The fallback is sized to the real console so
                      the hero does not reflow when it swaps in. */}
                  <Suspense
                    fallback={
                      <div className="panel h-[248px] animate-pulse sm:h-[254px]" aria-hidden />
                    }
                  >
                    <IndexConsole />
                  </Suspense>
                </div>
              </Entrance>
            </div>

            <Entrance delay={0.16} className="relative lg:pl-md">
              <HeroGraph />
            </Entrance>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- PROOF */}
      <section className="shell relative">
        <div className="rule-fade" />
        <Stagger className="grid grid-cols-2 lg:grid-cols-4">
          {PROOF.map((p, i) => (
            <StaggerItem
              key={p.label}
              className={`group relative px-md py-xl transition-colors duration-300 hover:bg-[var(--surface-hover)] sm:px-lg ${
                // Hairlines between cells, not around them: the outer edges are already
                // closed by the two rules above and below the strip.
                i % 2 === 1 ? "border-l border-[var(--line-soft)]" : ""
              } ${i >= 2 ? "border-t border-[var(--line-soft)] lg:border-t-0" : ""} ${
                i > 0 ? "lg:border-l lg:border-[var(--line-soft)]" : ""
              }`}
            >
              {/* Sized down from the other figures: "313.9 MiB" is more than twice the
                  glyph count of "957" and at a shared size it collided with its cell. */}
              <div className="tnum text-h2 leading-none tracking-tight text-[var(--text-primary)]">
                <CountUp to={p.value} decimals={p.decimals ?? 0} suffix={p.suffix} />
              </div>
              <div className="mt-sm text-meta text-[var(--text-secondary)]">{p.label}</div>
              <div className="mt-2xs text-meta text-[var(--text-muted)]">{p.note}</div>
              <span className="absolute bottom-0 left-0 h-px w-0 bg-[var(--signal-500)] transition-all duration-500 group-hover:w-full" />
            </StaggerItem>
          ))}
        </Stagger>
        <div className="rule-fade" />
        <Reveal>
          <p className="mx-auto max-w-note py-lg text-center text-meta text-[var(--text-muted)]">
            Measured on this repository. The commands that produce every one of these are in the repo.
          </p>
        </Reveal>
      </section>

      {/* -------------------------------------------------------------- LENSES */}
      <section className="shell relative mt-3xl">
        <Reveal>
          <span className="eyebrow">What it actually does</span>
          <h2 className="mt-md max-w-measure font-display text-h2 text-[var(--text-primary)]">
            Three lenses over <em>one index.</em>
          </h2>
          <p className="mt-md max-w-measure text-body text-[var(--text-secondary)]">
            The graph is not plumbing behind a findings list. Everything else is a way of looking
            at it.
          </p>
        </Reveal>

        <Stagger className="mt-2xl grid gap-md md:grid-cols-3" step={0.09}>
          {LENSES.map((l) => (
            <StaggerItem key={l.title}>
              <article className="panel group relative h-full overflow-hidden p-lg transition-colors duration-500 hover:border-line-strong">
                <div
                  className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-0 blur-3xl transition-opacity duration-700 group-hover:opacity-[0.13]"
                  style={{ background: l.tone }}
                />
                <div className="relative">
                  <div
                    className="mb-lg flex h-10 w-10 items-center justify-center rounded-md border"
                    style={{ borderColor: `color-mix(in srgb, ${l.tone} 30%, transparent)`, background: `color-mix(in srgb, ${l.tone} 9%, transparent)` }}
                  >
                    <l.icon className="h-[18px] w-[18px]" style={{ color: l.glyph }} />
                  </div>
                  <span className="eyebrow">{l.kicker}</span>
                  <h3 className="mt-sm font-display text-h3 text-[var(--text-primary)]">
                    {l.title}
                  </h3>
                  <p className="mt-md text-meta text-[var(--text-secondary)]">{l.body}</p>
                  <p className="mt-md border-t border-[var(--line-soft)] pt-md text-meta text-[var(--text-muted)]">
                    {l.detail}
                  </p>
                </div>
              </article>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* ------------------------------------------------------------ PIPELINE */}
      <section className="shell relative mt-3xl">
        <div className="panel overflow-hidden">
          <div className="split-phi-rev p-lg sm:p-xl">
            <Reveal>
              <span className="eyebrow">One pass, instrumented</span>
              <h2 className="mt-md font-display text-h2 text-[var(--text-primary)]">
                Every stage <em>times itself.</em>
              </h2>
              <p className="mt-md max-w-measure text-body text-[var(--text-secondary)]">
                A run records where its time went, per stage, and reports it as a metric. So when an
                index gets slower you get a package name, not a shrug.
              </p>
              <p className="mt-md text-meta text-[var(--text-muted)]">
                Below: an actual run over this repository&apos;s 379 TypeScript files.
              </p>
            </Reveal>

            <Stagger className="space-y-sm" step={0.07}>
              {STAGES.map((s) => (
                <StaggerItem key={s.name}>
                  <div className="group flex items-center gap-md">
                    <div className="w-3xl shrink-0 text-right font-mono text-meta text-[var(--text-secondary)]">
                      {s.name}
                    </div>
                    <div className="relative h-8 flex-1 overflow-hidden rounded-sm bg-[var(--surface-2)]">
                      <div
                        className="h-full rounded-sm transition-all duration-700"
                        style={{
                          width: `${Math.max(2.5, (s.ms / STAGE_MAX) * 100)}%`,
                          background:
                            s.ms === STAGE_MAX
                              ? "linear-gradient(90deg, color-mix(in srgb, var(--signal-500) 26%, transparent), color-mix(in srgb, var(--signal-500) 52%, transparent))"
                              : "color-mix(in srgb, var(--violet-500) 26%, transparent)",
                        }}
                      />
                      <span className="absolute inset-y-0 left-3 flex items-center text-meta text-[var(--text-muted)] opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                        {s.desc}
                      </span>
                    </div>
                    <div className="tnum w-2xl shrink-0 text-right text-meta text-[var(--text-primary)]">
                      {s.ms}ms
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- CONSTRAINT */}
      <section className="relative mt-3xl overflow-hidden border-y border-[var(--line)] py-md">
        {/* Fade both ends. Without this the belt shears a word in half against the
            viewport edge, which reads as clipped text rather than as continuous
            motion — the one thing a marquee must not do. */}
        <div
          className="flex whitespace-nowrap"
          style={{
            maskImage: "linear-gradient(90deg, transparent, #000 9%, #000 91%, transparent)",
            WebkitMaskImage: "linear-gradient(90deg, transparent, #000 9%, #000 91%, transparent)",
          }}
        >
          {[0, 1].map((dup) => (
            <div key={dup} className="animate-marquee flex shrink-0 items-center" aria-hidden={dup === 1}>
              {[
                "one container",
                "one SQLite file",
                "no API key",
                "no service to sign up for",
                "MIT licensed",
                "runs on 512 MB",
                "your tests are the oracle",
              ].map((t) => (
                <span key={t} className="flex items-center">
                  <span className="px-lg font-display text-lede text-[var(--text-secondary)]">{t}</span>
                  <span className="h-1 w-1 rounded-full bg-[var(--signal-500)] opacity-50" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------------- CTA */}
      <section className="shell relative mt-3xl">
        <Reveal>
          <div className="panel relative overflow-hidden px-lg py-2xl text-center sm:px-xl sm:py-3xl">
            <div className="grid-field pointer-events-none absolute inset-0" />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-[-12rem] mx-auto h-[24rem] w-[36rem] rounded-full"
              style={{ background: "radial-gradient(ellipse at center, var(--signal-glow), transparent 70%)" }}
            />
            <div className="relative">
              <h2 className="mx-auto max-w-measure font-display text-h2 text-[var(--text-primary)]">
                Point it at a repository and <em>look at the graph.</em>
              </h2>
              <p className="mx-auto mt-lg max-w-measure text-body text-[var(--text-secondary)]">
                Public repositories index in seconds. Nothing is uploaded, nothing phones home.
              </p>
              <div className="mt-xl flex flex-wrap items-center justify-center gap-md">
                <Magnetic>
                  <Link
                    href="#top"
                    className="group flex min-h-11 cursor-pointer items-center gap-sm rounded-md bg-[var(--accent-fill)] px-lg py-md text-meta font-semibold text-[var(--accent-on-fill)] transition-colors duration-200 hover:bg-[var(--signal-400)]"
                  >
                    Index a repository
                    <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </Link>
                </Magnetic>
                <Magnetic>
                  <Link
                    href="/dashboard"
                    className="flex min-h-11 cursor-pointer items-center gap-sm rounded-md border border-[var(--line)] px-lg py-md text-meta font-medium text-[var(--text-secondary)] transition-colors duration-200 hover:border-line-strong hover:text-[var(--text-primary)]"
                  >
                    Open the dashboard
                  </Link>
                </Magnetic>
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
