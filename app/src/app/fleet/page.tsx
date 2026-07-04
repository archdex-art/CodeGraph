"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Network } from "lucide-react";
import type { FleetGraph } from "@/lib/types";
import { NodeGraph, type NGNode, type NGEdge } from "@/components/NodeGraph";
import { forceLayout } from "@/lib/layout";

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
      <div className="flex items-center gap-2 text-gray-500 py-24 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Mapping enterprise fleet…
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center text-gray-400">
        No indexed repositories found. <Link href="/" className="text-purple-400">Start indexing</Link>
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
      color: n.score && n.score >= 80 ? "#34d399" : n.score && n.score >= 60 ? "#fbbf24" : "#fb7185",
    });
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-white mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Dashboard
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
            <Network className="w-8 h-8 text-cyan-400" /> Enterprise Fleet Graph
          </h1>
          <p className="text-sm text-gray-500 mt-2">
            Cross-repository dependency map built from <code>package.json</code> and <code>requirements.txt</code> analysis.
          </p>
        </div>
      </div>

      <div className="mb-6">
        <NodeGraph nodes={ngNodes} edges={ngEdges} height={700} />
      </div>
    </div>
  );
}
