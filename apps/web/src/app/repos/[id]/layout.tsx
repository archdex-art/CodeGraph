"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, ExternalLink, FolderGit2, Loader2 } from "lucide-react";
import { GithubMark } from "@/components/GithubMark";
import { fetchRepo } from "@/lib/api";
import type { RepoDetail } from "@/lib/types";
import { RepoProvider } from "./repo-context";
import { GROUPED, SECTIONS, sectionHref } from "./sections";

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

  useEffect(() => {
    fetchRepo(id)
      .then(setRepo)
      .catch(() => setNotFound(true));
  }, [id]);

  const current = SECTIONS.find((s) => pathname === sectionHref(id, s.slug));

  if (notFound) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <p className="eyebrow mb-3">404</p>
        <p className="text-[var(--text-secondary)]">
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
      <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-[var(--text-muted)]">
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

  const navLink = (slug: string, label: string, Icon: (typeof SECTIONS)[number]["icon"]) => {
    const href = sectionHref(id, slug);
    const active = pathname === href;
    const count = countFor(slug);
    return (
      <Link
        key={slug || "overview"}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`relative flex min-h-10 shrink-0 cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-lg px-3 text-[13.5px] transition-colors duration-200 ${
          active
            ? "text-[var(--text-primary)] lg:bg-white/[0.04]"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] lg:hover:bg-white/[0.02]"
        }`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${active ? "text-[var(--signal-500)]" : "text-[var(--text-faint)]"}`} />
        {label}
        {count !== null && (
          <span
            className={`tnum ml-auto hidden rounded px-1.5 py-0.5 text-[10.5px] leading-none transition-colors duration-200 lg:block ${
              active
                ? "bg-white/[0.06] text-[var(--text-secondary)]"
                : "bg-white/[0.03] text-[var(--text-faint)]"
            }`}
            title={`${count.toLocaleString()} in this section`}
          >
            {compact(count)}
          </span>
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
      <div className="mx-auto max-w-[1440px] px-6 lg:grid lg:grid-cols-[214px_minmax(0,1fr)] lg:gap-9">
        {/* ------------------------------------------------------------ SIDEBAR */}
        <aside className="hidden lg:block">
          <div className="sticky top-[4.5rem] py-8">
            <Link
              href="/dashboard"
              className="mb-5 inline-flex min-h-9 cursor-pointer items-center gap-2 text-[13px] text-[var(--text-muted)] transition-colors duration-200 hover:text-[var(--text-primary)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Link>

            {/* Which repository you are inside, pinned. On a deep section the page
                title has scrolled away and this is the only thing still saying it. */}
            <div className="mb-6 flex items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--ink-850)] px-3 py-2.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-[var(--signal-500)]" : "bg-[var(--amber-400)]"}`}
                aria-hidden="true"
              />
              <span className="truncate text-[13px] text-[var(--text-secondary)]" title={repo.name}>
                {repo.name}
              </span>
            </div>

            <nav aria-label="Report sections" className="flex flex-col gap-5">
              {GROUPED.map(({ group, items }) => (
                <div key={group}>
                  {group !== "Report" && <p className="eyebrow mb-1.5 px-3">{group}</p>}
                  {/* A hairline running the height of the group, with the items indented
                      off it. Grouping you can see without drawing a box around it — the
                      eyebrow alone left three lists floating at the same indent, so the
                      headings were the only thing separating them. The ungrouped
                      "Report" item stays flush so it reads as the root, not a child. */}
                  <div
                    className={`flex flex-col gap-0.5 ${
                      group !== "Report" ? "ml-3 border-l border-[var(--line-soft)] pl-1.5" : ""
                    }`}
                  >
                    {items.map((s) => navLink(s.slug, s.label, s.icon))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        </aside>

        {/* --------------------------------------------------------------- MAIN */}
        <div className="min-w-0 pb-8 lg:border-l lg:border-[var(--line)] lg:pl-9">
          {/* Mobile: the sidebar collapses to a scrollable rail rather than a
              hamburger — section switching is the primary action on this page and
              hiding it behind a menu costs a tap on every move. */}
          <div className="-mx-6 mb-6 border-b border-[var(--line)] px-6 pt-6 lg:hidden">
            <Link
              href="/dashboard"
              className="mb-3 inline-flex min-h-9 cursor-pointer items-center gap-2 text-[13px] text-[var(--text-muted)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Link>
            <div className="flex gap-1 overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
              title now sits one step above the section headings (28px vs 24px) and well
              below the numeral. The icon tile came down with it — a 48px tile beside
              28px type reads as a logo rather than a source marker. */}
          <header className="pt-0 lg:pt-8">
            <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
              <div className="flex min-w-0 items-start gap-3.5">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--ink-800)]">
                  {repo.sourceType === "git" ? (
                    <GithubMark className="h-[18px] w-[18px] text-[var(--text-secondary)]" />
                  ) : (
                    <FolderGit2 className="h-[18px] w-[18px] text-[var(--text-secondary)]" />
                  )}
                </span>
                <div className="min-w-0">
                  <h1 className="font-display truncate text-[1.75rem] leading-tight tracking-tight">
                    {hasOwner && <span className="text-[var(--text-muted)]">{owner} / </span>}
                    <span className="text-[var(--text-primary)]">{shortName}</span>
                  </h1>

                  {/* Meta row. Every item is something the index actually recorded —
                      there is no description field on a repo, so none is invented. */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-[var(--text-muted)]">
                    {repo.languages?.[0] && (
                      <span className="flex items-center gap-1.5">
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
                        className="flex cursor-pointer items-center gap-1.5 truncate font-mono transition-colors duration-200 hover:text-[var(--text-secondary)]"
                      >
                        {repo.url.replace(/^https?:\/\//, "")}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="truncate font-mono">{repo.url}</span>
                    )}
                  </div>

                  <p className="mt-1.5 text-[12.5px] text-[var(--text-faint)]">
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
              <div className="flex shrink-0 items-center gap-2.5">
                <Link
                  href={sectionHref(id, "code-intel")}
                  className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--line)] px-3.5 text-[13px] text-[var(--text-secondary)] transition-colors duration-200 hover:border-line-strong hover:text-[var(--text-primary)]"
                >
                  Query the graph
                </Link>
                <Link
                  href={sectionHref(id, "agents")}
                  className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--signal-500)] px-3.5 text-[13px] font-medium text-[var(--ink-900)] transition-colors duration-200 hover:bg-[var(--signal-400)]"
                >
                  Run the swarm
                </Link>
              </div>
            </div>

            <div className="mt-6 h-px bg-[var(--line)]" />
          </header>

          <div className="pt-8">{children}</div>
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
