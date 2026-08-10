"use client";

import { NetworkView } from "@/components/NetworkView";
import { GraphWorkbench } from "@/components/GraphWorkbench";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function NetworkPage() {
  const repo = useRepo();
  return (
    <>
      {repo.viz && repo.viz.nodes.length > 0 ? (
        <GraphWorkbench repoId={repo.id} graph={repo.symbolGraph} immersive>
          {(onSelect) => <NetworkView graph={repo.viz!} repoName={repo.name} onSelect={onSelect} immersive />}
        </GraphWorkbench>
      ) : (
        <Empty msg="No import network for this repository." />
      )}
    </>
  );
}
