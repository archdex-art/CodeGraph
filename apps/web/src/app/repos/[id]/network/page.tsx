"use client";

import { NetworkView } from "@/components/NetworkView";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function NetworkPage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Structure"
        title="Import network"
        blurb="Force-directed layout of the import graph. What clusters together is what actually coheres — which is not always what the directory tree claims."
      />
      {repo.viz && repo.viz.nodes.length > 0 ? (
        <NetworkView graph={repo.viz} />
      ) : (
        <Empty msg="No import network for this repository." />
      )}
    </>
  );
}
