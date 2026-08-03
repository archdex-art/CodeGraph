"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Loader2, Network } from "lucide-react";
import type { FleetGraph } from "@/lib/types";
import { NodeGraph, type NGNode, type NGEdge } from "@/components/NodeGraph";
import { forceLayout } from "@/lib/layout";
import { Reveal } from "@/components/motion/primitives";

/**
 * Health bands for the graph nodes.
 *
 * Tokens, not literals. `fill`/`stroke` presentation attributes are parsed as CSS
 * values, so `var()` resolves in them exactly as it does in `style` — which is
 * what `NodeGraph` already relies on for its own surfaces. Literals mattered here
 * because amber and coral are the two hues that actually move between themes: a
 * frozen #ff6b57 is a pastel smear on paper.
 */
const BAND = { good: "var(--signal-500)", mid: "var(--amber-400)", poor: "var(--coral-500)" } as const;

function bandColor(score: number | null): string {
  if (score !== null && score >= 80) return BAND.good;
  if (score !== null && score >= 60) return BAND.mid;
  return BAND.poor;
}

/** The same reading as TEXT — the fill hues above cannot carry a numeral on paper. */
function scoreColor(s: number | null): string {
  if (s === null) return "text-[var(--text-muted)]";
  if (s >= 80) return "text-[var(--accent-text)]";
  if (s >= 60) return "text-[var(--amber-text)]";
  return "text-[var(--coral-text)]";
}

/** One grid track definition shared by the header row and every data row. */
const ROW =
  "grid grid-cols-[minmax(0,1fr)_5rem_4rem] items-center gap-md sm:grid-cols-[minmax(0,1fr)_4.5rem_7rem_5rem_4rem]";

const BTN_PRIMARY =
  "inline-flex min-h-11 cursor-pointer items-center gap-sm rounded-lg bg-[var(--accent-fill)] px-md text-meta font-medium text-[var(--accent-on-fill)] transition-colors duration-200 hover:bg-[var(--signal-400)]";
const BTN_GHOST =
  "inline-flex min-h-11 cursor-pointer items-center gap-sm rounded-lg border border-[var(--line)] px-md text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--line-strong)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]";

export default function FleetPage() {
  const [graph, setGraph] = useState<FleetGraph | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/fleet")
      .then((res) => res.json())
      .then((data: FleetGraph) => {
        setGraph(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="shell py-2xl">
        <div className="panel px-lg py-lg sm:px-lg">
          <p className="eyebrow flex items-center gap-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Mapping fleet
          </p>
          <p className="mt-sm max-w-note text-meta leading-relaxed text-[var(--text-secondary)]">
            Reading every indexed manifest and resolving the dependencies they share into a single
            cross-repository graph.
          </p>
          <div
            className="grid-field mt-lg h-64 rounded-xl border border-[var(--line-soft)] bg-[var(--surface-2)]"
            aria-hidden="true"
          />
          <Link href="/dashboard" className={`${BTN_GHOST} mt-lg`}>
            <ArrowLeft className="h-4 w-4" /> Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="shell py-2xl">
        <div className="panel flex flex-col items-start gap-md px-lg py-xl sm:px-xl">
          <Network className="h-6 w-6 text-[var(--text-faint)]" />
          <div>
            <p className="eyebrow">Fleet empty</p>
            <p className="mt-sm max-w-note text-meta leading-relaxed text-[var(--text-secondary)]">
              No indexed repositories, so there is nothing to draw edges between. Index two or more
              and the packages they share become the map.
            </p>
          </div>
          <Link href="/" className={BTN_PRIMARY}>
            Start indexing <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    );
  }

  const ngNodes: NGNode[] = [];
  const ngEdges: NGEdge[] = graph.edges.map(e => ({ source: e.source, target: e.target, weight: 1 }));

  const pos = forceLayout(
    graph.nodes.map(n => n.id),
    ngEdges,
    { collideW: 180, collideH: 64, iterations: 400 }
  );

  for (const n of graph.nodes) {
    const p = pos.get(n.id) || { x: 0, y: 0 };
    ngNodes.push({
      id: n.id,
      x: p.x,
      y: p.y,
      w: 180,
      h: 64,
      label: n.name,
      subtitle: n.sourceType === "git" ? "git repo" : "local folder",
      meta: `${n.loc.toLocaleString()} LOC · Score: ${n.score || 0}`,
      color: bandColor(n.score),
    });
  }

  // Outgoing edges per repo — how many other repos this one reaches.
  const outDegree = new Map<string, number>();
  for (const e of graph.edges) outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);

  return (
    <div className="shell py-xl">
      <Link
        href="/dashboard"
        className="inline-flex min-h-11 cursor-pointer items-center gap-sm text-meta text-[var(--text-muted)] transition-colors duration-200 hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" /> Dashboard
      </Link>

      <div className="mt-md flex flex-wrap items-end justify-between gap-lg">
        <div>
          <p className="eyebrow">Cross-repository</p>
          <h1 className="font-display mt-sm flex items-center gap-sm text-h1 tracking-tight text-[var(--text-primary)] sm:text-display">
            <Network className="h-8 w-8 shrink-0 text-[var(--violet-400)]" />
            Fleet <em>graph</em>
          </h1>
          <p className="mt-sm max-w-note text-meta leading-relaxed text-[var(--text-secondary)]">
            Dependency edges between indexed repositories, resolved from <code className="font-mono text-[var(--text-primary)]">package.json</code> and{" "}
            <code className="font-mono text-[var(--text-primary)]">requirements.txt</code>.
          </p>
        </div>

        <dl className="panel grid grid-cols-2 divide-x divide-[var(--line)]">
          <div className="px-md py-md">
            <dt className="eyebrow">Repos</dt>
            <dd className="tnum mt-xs text-lede text-[var(--text-primary)]">{graph.nodes.length}</dd>
          </div>
          <div className="px-md py-md">
            <dt className="eyebrow">Edges</dt>
            <dd className="tnum mt-xs text-lede text-[var(--text-primary)]">{graph.edges.length}</dd>
          </div>
        </dl>
      </div>

      <div className="rule-fade my-lg" />

      <div className="panel grain relative overflow-hidden">
        <NodeGraph nodes={ngNodes} edges={ngEdges} height={700} />
      </div>

      <div className="mt-xl flex items-baseline justify-between gap-md">
        <h2 className="font-display text-h3 tracking-tight text-[var(--text-primary)]">
          Fleet <em>index</em>
        </h2>
        <p className="eyebrow">
          <span className="tnum">{graph.nodes.length}</span> repositories
        </p>
      </div>

      <Reveal className="panel mt-md overflow-hidden">
        <div className={`${ROW} border-b border-[var(--line)] px-md py-sm`}>
          <span className="eyebrow">Repository</span>
          <span className="eyebrow hidden sm:block">Source</span>
          <span className="eyebrow hidden text-right sm:block">LOC</span>
          <span className="eyebrow text-right">Edges</span>
          <span className="eyebrow text-right">Score</span>
        </div>

        <div className="divide-y divide-[var(--line-soft)]">
          {graph.nodes.map((n) => (
            <Link
              key={n.id}
              href={`/repos/${n.id}`}
              className={`${ROW} min-h-[3.25rem] cursor-pointer px-md py-sm transition-colors duration-200 hover:bg-[var(--surface-hover)]`}
            >
              <span className="min-w-0">
                <span className="block truncate text-meta text-[var(--text-primary)]">{n.name}</span>
                <span className="block truncate font-mono text-meta text-[var(--text-muted)]">{n.url}</span>
              </span>
              <span className="eyebrow hidden sm:block">{n.sourceType === "git" ? "git" : "local"}</span>
              <span className="tnum hidden text-right text-meta text-[var(--text-secondary)] sm:block">
                {n.loc.toLocaleString()}
              </span>
              <span className="tnum text-right text-meta text-[var(--text-secondary)]">
                {outDegree.get(n.id) ?? 0}
              </span>
              <span className={`tnum text-right text-meta ${scoreColor(n.score)}`}>{n.score ?? "—"}</span>
            </Link>
          ))}
        </div>
      </Reveal>
    </div>
  );
}
