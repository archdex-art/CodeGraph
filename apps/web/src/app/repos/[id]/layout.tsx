"use client";

import { use, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, ExternalLink, FolderGit2, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { GithubMark } from "@/components/GithubMark";
import { fetchRepo } from "@/lib/api";
import type { RepoDetail } from "@/lib/types";
import { RepoProvider } from "./repo-context";
import { GROUPED, SECTIONS, sectionHref } from "./sections";

/**
 * The rail's collapsed state, as a minimal external store.
 *
 * localStorage is the storage, but it is not a store: writing to it notifies nobody
 * in the writing tab (`storage` fires only in the OTHER tabs), so a subscriber set
 * carries the local notification and the event carries the cross-tab one. Both are
 * needed — open the same report twice and the two rails should agree.
 */
const RAIL_KEY = "cg:rail-collapsed";
const railListeners = new Set<() => void>();

function subscribeRail(onChange: () => void): () => void {
  railListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    railListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Must return a stable value for an unchanged store — a boolean is stable by value. */
function readRail(): boolean {
  return window.localStorage.getItem(RAIL_KEY) === "1";
}

function writeRail(collapsed: boolean): void {
  window.localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
  for (const notify of railListeners) notify();
}

/**
 * Shell for one repository's report.
 *
 * Owns the fetch and the page's identity — name, source, section navigation — so all
 * of it persists while the section beneath changes. A Next nested layout is not
 * remounted when its child route changes, which is what makes one fetch cover every
 * section rather than one per visit.
 *
 * The sections used to be seven hidden `<div>`s in a single 463-line page, so Monaco,
 * three graph renderers, the swarm and the timeline all mounted whether or not you
 * opened them. Real routes mount exactly one.
 */
export default function RepoLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const pathname = usePathname();
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  /**
   * The rail collapses to icons so a graph, an editor or a diff can have the width.
   *
   * `useSyncExternalStore` rather than `useState` + an effect, because the state is
   * genuinely EXTERNAL: it lives in localStorage, it outlives the component, and it
   * is shared with every other tab. Reading it in an effect meant a cascading render
   * on every mount (which `react-hooks/set-state-in-effect` flags as an error in this
   * file), and reading it during render would have desynced from the server HTML.
   * This hook exists for exactly that shape: `getServerSnapshot` returns the expanded
   * default, so the server and the first client paint agree, and React re-renders
   * once with the stored value after hydration.
   */
  const collapsed = useSyncExternalStore(subscribeRail, readRail, () => false);

  const toggleRail = () => writeRail(!collapsed);

  useEffect(() => {
    fetchRepo(id)
      .then(setRepo)
      .catch(() => setNotFound(true));
  }, [id]);

  const current = SECTIONS.find((s) => pathname === sectionHref(id, s.slug));

  if (notFound) {
    return (
      <div className="shell py-3xl text-center">
        <p className="eyebrow mb-md">404</p>
        <p className="mx-auto max-w-measure text-body text-[var(--text-secondary)]">
          Repository not found.{" "}
          <Link
            href="/dashboard"
            className="cursor-pointer text-[var(--signal-500)] underline decoration-[var(--signal-500)]/30 underline-offset-4 transition-colors duration-200 hover:decoration-[var(--signal-500)]"
          >
            Back to dashboard
          </Link>
        </p>
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="flex items-center justify-center gap-sm py-3xl text-meta text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--signal-500)]" /> Loading report…
      </div>
    );
  }

  const [owner, ...rest] = repo.name.split("/");
  const shortName = rest.join("/") || owner;
  const hasOwner = rest.length > 0;
  const live = repo.status === "done";

  /**
   * What is inside a section, shown before you go there.
   *
   * Every figure is read off the payload the layout already fetched — no extra
   * request, and nothing that could disagree with the page it links to. Sections
   * with no honest count (Overview, Editor, Timeline — the last needs a separate
   * history fetch) get no badge rather than a zero, because a zero here would read
   * as "empty" when it means "not counted".
   *
   * Neutral, never coloured: these are magnitudes, not alerts, and the accents on
   * this surface are reserved for readings, structure and risk.
   */
  const countFor = (slug: string): number | null => {
    switch (slug) {
      case "architecture":
        return repo.modules?.nodes.length ?? null;
      case "circle-pack":
        return repo.graphStats?.files || null;
      case "network":
        return repo.viz?.nodes.length || null;
      case "code-intel":
        return repo.symbolGraph?.stats.symbols || null;
      case "agents":
        return repo.issues.length || null;
      default:
        return null;
    }
  };

  const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

  /**
   * `rail` = the desktop sidebar (collapsible); the mobile strip passes `false` for
   * `railCollapsed` because it is horizontal and always labelled.
   *
   * Collapsed, the label and count are REMOVED from the DOM rather than hidden with
   * a width transition: a 68px rail cannot hold them, and `overflow:hidden` on text
   * that is still laid out is what produces the half-clipped word every collapsed
   * sidebar eventually shows. The label survives as the accessible name and as the
   * native tooltip, so the control is still identifiable by pointer and by screen
   * reader.
   */
  const navLink = (
    slug: string,
    label: string,
    Icon: (typeof SECTIONS)[number]["icon"],
    railCollapsed = false
  ) => {
    const href = sectionHref(id, slug);
    const active = pathname === href;
    const count = countFor(slug);
    return (
      <Link
        key={slug || "overview"}
        href={href}
        aria-current={active ? "page" : undefined}
        aria-label={railCollapsed ? label : undefined}
        title={railCollapsed ? (count !== null ? `${label} · ${count.toLocaleString()}` : label) : undefined}
        className={`relative flex min-h-10 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-md text-meta transition-colors duration-200 ${
          railCollapsed ? "w-10 justify-center px-0" : "gap-sm px-sm"
        } ${
          active
            ? "text-[var(--text-primary)] lg:bg-white/[0.04]"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] lg:hover:bg-white/[0.02]"
        }`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${active ? "text-[var(--signal-500)]" : "text-[var(--text-faint)]"}`} />
        {!railCollapsed && label}
        {!railCollapsed && count !== null && (
          <span
            className={`tnum ml-auto hidden rounded-xs px-xs py-2xs text-micro leading-none transition-colors duration-200 lg:block ${
              active
                ? "bg-white/[0.06] text-[var(--text-secondary)]"
                : "bg-white/[0.03] text-[var(--text-faint)]"
            }`}
            title={`${count.toLocaleString()} in this section`}
          >
            {compact(count)}
          </span>
        )}
        {/* Collapsed, the count would not fit — but "this section has 173 things in
            it" is still worth a glyph, so it degrades to a dot rather than vanishing. */}
        {railCollapsed && count !== null && count > 0 && (
          <span
            aria-hidden="true"
            className={`absolute right-1 top-1.5 h-1 w-1 rounded-full transition-colors duration-200 ${
              active ? "bg-[var(--signal-500)]" : "bg-[var(--text-faint)]"
            }`}
          />
        )}
        {active && (
          <motion.span
            layoutId="section-marker"
            className="absolute bg-[var(--signal-500)] max-lg:inset-x-2 max-lg:-bottom-px max-lg:h-[2px] lg:inset-y-1.5 lg:-left-px lg:w-[2px]"
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          />
        )}
      </Link>
    );
  };

  return (
    <RepoProvider value={repo}>
      <div
        className={`shell lg:grid lg:gap-lg lg:transition-[grid-template-columns] lg:duration-300 lg:[transition-timing-function:var(--ease-out-expo)] ${
          collapsed
            ? "lg:grid-cols-[var(--rail-collapsed)_minmax(0,1fr)]"
            : "lg:grid-cols-[var(--rail)_minmax(0,1fr)]"
        }`}
      >
        {/* ------------------------------------------------------------ SIDEBAR */}
        <aside className="hidden lg:block" id="report-rail">
          <div className="sticky top-[4.5rem] py-xl">
            {/* Collapse control. Sits above everything the rail contains, because it
                governs all of it — and stays in the same place in both states so the
                pointer does not have to hunt for the way back. */}
            <div className={`mb-lg flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
              {!collapsed && (
                <Link
                  href="/dashboard"
                  className="inline-flex min-h-9 cursor-pointer items-center gap-sm text-meta text-[var(--text-muted)] transition-colors duration-200 hover:text-[var(--text-primary)]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
                </Link>
              )}
              <button
                type="button"
                onClick={toggleRail}
                aria-expanded={!collapsed}
                aria-controls="report-rail"
                aria-label={collapsed ? "Expand section navigation" : "Collapse section navigation"}
                title={collapsed ? "Expand navigation" : "Collapse navigation"}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-[var(--text-faint)] transition-colors duration-200 hover:bg-white/[0.03] hover:text-[var(--text-secondary)]"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </button>
            </div>

            {/* Which repository you are inside, pinned. On a deep section the page
                title has scrolled away and this is the only thing still saying it.
                Collapsed, it keeps only the status dot — the one part of it that is
                still legible at 68px, and the part that changes. */}
            {collapsed ? (
              <div className="mb-lg flex justify-center" title={repo.name}>
                <Link
                  href="/dashboard"
                  aria-label="Back to dashboard"
                  className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-[var(--line)] bg-[var(--ink-850)] transition-colors duration-200 hover:border-[var(--line-strong)]"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${live ? "bg-[var(--signal-500)]" : "bg-[var(--amber-400)]"}`}
                    aria-hidden="true"
                  />
                </Link>
              </div>
            ) : (
              <div className="mb-lg flex items-center gap-sm rounded-md border border-[var(--line)] bg-[var(--ink-850)] px-sm py-sm">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-[var(--signal-500)]" : "bg-[var(--amber-400)]"}`}
                  aria-hidden="true"
                />
                <span className="truncate text-meta text-[var(--text-secondary)]" title={repo.name}>
                  {repo.name}
                </span>
              </div>
            )}

            <nav
              aria-label="Report sections"
              className={`flex flex-col ${collapsed ? "items-center gap-md" : "gap-lg"}`}
            >
              {GROUPED.map(({ group, items }) => (
                <div key={group} className={collapsed ? "flex flex-col items-center gap-2xs" : undefined}>
                  {/* Collapsed, the group heading is dropped and the separation is
                      carried by a rule instead: at 68px an eyebrow either wraps or
                      truncates to two letters, and neither is a heading. */}
                  {!collapsed && group !== "Report" && <p className="eyebrow mb-xs px-sm">{group}</p>}
                  {collapsed && group !== "Report" && (
                    <span className="mb-2xs h-px w-4 bg-[var(--line)]" aria-hidden="true" />
                  )}
                  {/* A hairline running the height of the group, with the items indented
                      off it. Grouping you can see without drawing a box around it — the
                      eyebrow alone left three lists floating at the same indent, so the
                      headings were the only thing separating them. The ungrouped
                      "Report" item stays flush so it reads as the root, not a child. */}
                  <div
                    className={`flex flex-col gap-2xs ${
                      !collapsed && group !== "Report" ? "ml-sm border-l border-[var(--line-soft)] pl-xs" : ""
                    }`}
                  >
                    {items.map((s) => navLink(s.slug, s.label, s.icon, collapsed))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        </aside>

        {/* --------------------------------------------------------------- MAIN */}
        <div className="min-w-0 pb-xl lg:border-l lg:border-[var(--line)] lg:pl-lg">
          {/* Mobile: the sidebar collapses to a scrollable rail rather than a
              hamburger — section switching is the primary action on this page and
              hiding it behind a menu costs a tap on every move. */}
          <div className="-mx-lg mb-lg border-b border-[var(--line)] px-lg pt-lg lg:hidden">
            <Link
              href="/dashboard"
              className="mb-md inline-flex min-h-9 cursor-pointer items-center gap-sm text-meta text-[var(--text-muted)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Link>
            {/* `min-w-0` is load-bearing: without it this flex child sizes to its
                content (every section pill laid end to end), so the rail scrolled AND
                the page grew — 232px of horizontal overflow on a 390px viewport. */}
            <div className="flex min-w-0 gap-2xs overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {SECTIONS.map((s) => navLink(s.slug, s.label, s.icon))}
            </div>
          </div>

          {/* ------------------------------------------------------------ HEADER */}
          {/* Scale note. Measured before changing anything: the title rendered at 38px
              against a 56px health numeral, a 24px section heading and 13–15px chrome.
              That put the repository's NAME within touching distance of the reading the
              page exists to deliver, and more than half again the size of the headings
              that organise it.

              On a report the score is the hero and the name is identification, so the
              title now sits on `text-h3` (26) — one rung above the in-page section
              headings at `text-lede` (20), and well below the numeral. The icon tile
              came down with it: a 48px tile beside 26px type reads as a logo rather
              than a source marker. */}
          <header className="pt-0 lg:pt-xl">
            <div className="flex flex-wrap items-start justify-between gap-x-xl gap-y-md">
              <div className="flex min-w-0 items-start gap-md">
                <span className="mt-2xs flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--ink-800)]">
                  {repo.sourceType === "git" ? (
                    <GithubMark className="h-[18px] w-[18px] text-[var(--text-secondary)]" />
                  ) : (
                    <FolderGit2 className="h-[18px] w-[18px] text-[var(--text-secondary)]" />
                  )}
                </span>
                <div className="min-w-0">
                  <h1 className="font-display truncate text-h3 tracking-tight">
                    {hasOwner && <span className="text-[var(--text-muted)]">{owner} / </span>}
                    <span className="text-[var(--text-primary)]">{shortName}</span>
                  </h1>

                  {/* Meta row. Every item is something the index actually recorded —
                      there is no description field on a repo, so none is invented. */}
                  <div className="mt-sm flex flex-wrap items-center gap-x-md gap-y-xs text-meta text-[var(--text-muted)]">
                    {repo.languages?.[0] && (
                      <span className="flex items-center gap-xs">
                        <span className="h-2 w-2 rounded-full bg-[var(--violet-500)]" aria-hidden="true" />
                        {repo.languages[0].language}
                      </span>
                    )}
                    <span className="tnum">{repo.loc.toLocaleString()} LOC</span>
                    {repo.sourceType === "git" ? (
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex cursor-pointer items-center gap-xs truncate font-mono transition-colors duration-200 hover:text-[var(--text-secondary)]"
                      >
                        {repo.url.replace(/^https?:\/\//, "")}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="truncate font-mono">{repo.url}</span>
                    )}
                  </div>

                  <p className="mt-xs text-micro text-[var(--text-faint)]">
                    Indexed {relative(repo.finishedAt ?? repo.createdAt)}
                    {repo.coverage && (
                      <>
                        {" · "}
                        <span className="tnum">
                          {repo.coverage.filesAnalysed.toLocaleString()}
                        </span>{" "}
                        of <span className="tnum">{repo.coverage.filesSeen.toLocaleString()}</span> files scanned
                      </>
                    )}
                  </p>
                </div>
              </div>

              {/* Side by side, not stacked. Two 44px buttons in a column stood 98px tall
                  against a header block that is now ~70px — the actions were physically
                  larger than the thing they act on. Row layout also puts the primary
                  action on the same optical line as the title. `min-h-10` keeps a
                  comfortable target while no longer setting the header's height. */}
              <div className="flex shrink-0 items-center gap-sm">
                <Link
                  href={sectionHref(id, "code-intel")}
                  className="flex min-h-10 cursor-pointer items-center justify-center gap-sm rounded-md border border-[var(--line)] px-md text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-line-strong hover:text-[var(--text-primary)]"
                >
                  Query the graph
                </Link>
                <Link
                  href={sectionHref(id, "agents")}
                  className="flex min-h-10 cursor-pointer items-center justify-center gap-sm rounded-md bg-[var(--signal-500)] px-md text-meta font-medium text-[var(--ink-900)] transition-colors duration-200 hover:bg-[var(--signal-400)]"
                >
                  Run the swarm
                </Link>
              </div>
            </div>

            <div className="mt-lg h-px bg-[var(--line)]" />
          </header>

          <div className="pt-xl">{children}</div>
        </div>
      </div>
    </RepoProvider>
  );
}

/** Compact relative time — an absolute date makes you do arithmetic. */
function relative(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2_592_000) return `${Math.floor(s / 86_400)}d ago`;
  return `${Math.floor(s / 2_592_000)}mo ago`;
}
