import {
  Bot,
  CircleDot,
  Code2,
  Gauge,
  History,
  LayoutGrid,
  MessagesSquare,
  Network,
  Radius,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The sections of a repository report, declared once.
 *
 * Both the sticky sub-navigation and the index cards on the overview read from this
 * list, so a section cannot appear in the nav and be missing from the index, or be
 * added to one and forgotten in the other — which is exactly what happened to the
 * seven tabs this replaced.
 */
/** Sidebar grouping, mirroring how the sections are actually used. */
export type Group = "Report" | "Structure" | "Intelligence" | "History";

export type Section = {
  group: Group;
  /** URL segment, appended to `/repos/<id>`. Empty string is the overview itself. */
  slug: string;
  label: string;
  icon: LucideIcon;
  /** One line, shown on the overview index cards. Says what the section answers. */
  blurb: string;
  /** Editor needs the full window; everything else reads better in a column. */
  wide?: boolean;
  /** Full-bleed canvas: hides site chrome and repo header, fills the viewport. */
  immersive?: boolean;
};

export const SECTIONS: readonly Section[] = [
  {
    group: "Report",
    slug: "",
    label: "Overview",
    icon: Gauge,
    blurb: "The Health Score, what it was computed over, and the findings behind it.",
  },
  {
    group: "Structure",
    slug: "architecture",
    label: "Architecture",
    icon: LayoutGrid,
    blurb: "Top-level modules layered by dependency direction — entry points on top.",
    immersive: true,
  },
  {
    group: "Structure",
    slug: "circle-pack",
    label: "Circle pack",
    icon: CircleDot,
    blurb: "The file tree as nested area, so size and depth are visible at once.",
  },
  {
    group: "Structure",
    slug: "network",
    label: "Network",
    icon: Network,
    blurb: "Force-directed import graph. Click a file to inspect its symbols and callers.",
    immersive: true,
  },
  {
    group: "Intelligence",
    slug: "ask",
    label: "Ask",
    icon: MessagesSquare,
    blurb: "A question in English, compiled into graph operations and answered from the index.",
  },
  {
    group: "Intelligence",
    slug: "impact",
    label: "Impact",
    icon: Radius,
    blurb: "What breaks if you change a symbol, and which hubs no test reaches.",
  },
  {
    group: "Intelligence",
    slug: "ownership",
    label: "Ownership",
    icon: Users,
    blurb: "Who knows this code, where nobody does any more, and who should review a change.",
  },
  {
    group: "Intelligence",
    slug: "agents",
    label: "Agents",
    icon: Bot,
    blurb: "Run the specialist swarm and get a ranked, argued-out remediation plan.",
  },
  {
    group: "Intelligence",
    slug: "editor",
    label: "Editor",
    icon: Code2,
    blurb: "Git-integrated file browser and editor. Commit and push without leaving.",
    wide: true,
  },
  {
    group: "History",
    slug: "timeline",
    label: "Timeline",
    icon: History,
    blurb: "How the score and the graph moved across the repository's history.",
  },
];

/** `/repos/<id>` for the overview, `/repos/<id>/<slug>` for the rest. */
export function sectionHref(id: string, slug: string): string {
  return slug ? `/repos/${id}/${slug}` : `/repos/${id}`;
}

/** Sections in sidebar order, bucketed by group. Order follows SECTIONS. */
export const GROUPED: ReadonlyArray<{ group: Group; items: readonly Section[] }> = (
  ["Report", "Structure", "Intelligence", "History"] as const
).map((group) => ({ group, items: SECTIONS.filter((s) => s.group === group) }));
